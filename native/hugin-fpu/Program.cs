using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Hugin.Common;
using Hugin.POS.CompactPrinter.FP300;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AriHuginFpu
{
    /// <summary>
    /// stdin'den satır başına bir JSON istek okur, stdout'a satır başına bir JSON
    /// cevap yazar. Aynı anda tek istek: cihaz da tek belge tutuyor.
    ///
    /// İstek:  {"id":1,"cmd":"status"}
    /// Cevap:  {"id":1,"ok":true,"raw":"0|1|..."}            — cihazın kendi cevabı
    ///         {"id":1,"ok":false,"kind":"usage","error":"…"} — cihaza HİÇBİR ŞEY gitmedi
    ///         {"id":1,"ok":false,"kind":"transport",…}       — gitti, cevap gelmedi
    ///
    /// "usage" ile "transport" ayrımı para yolunun dayanağı: ilki güvenle ret
    /// sayılır, ikincisinde kart çekilmiş olabilir ve ajan "bilmiyorum" der.
    /// </summary>
    internal static class Program
    {
        private static int Main()
        {
            var utf8 = new UTF8Encoding(false);
            var input = new StreamReader(Console.OpenStandardInput(), utf8);
            var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };

            // Kütüphane Console'a bir şey yazarsa protokol satırı bozulmasın:
            // Console.Out stderr'e gider, cevaplar yalnızca `output`'tan.
            Console.SetOut(new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true });

            using (var device = new Device())
            {
                Write(output, new JObject { ["ready"] = true, ["version"] = Reply.Version });
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    Write(output, Dispatch(device, line));
                }
            }
            return 0;
        }

        private static void Write(StreamWriter output, JObject message)
        {
            output.WriteLine(message.ToString(Formatting.None));
        }

        /// <summary>
        /// İZİN LİSTESİ. Yalnızca satış, kurtarma ve gün sonu için gereken
        /// çağrılar var; servis, programlama ve mali bellek komutları bilerek
        /// yok — ajanın kötüye kullanılan bir kopyası bile cihazı
        /// programlayamasın.
        /// </summary>
        private static JObject Dispatch(Device device, string line)
        {
            JObject request;
            try
            {
                request = JObject.Parse(line);
            }
            catch (JsonException)
            {
                return Reply.Usage(null, "Geçersiz istek");
            }

            var id = request["id"];
            try
            {
                switch ((string)request["cmd"])
                {
                    case "connect":
                        return device.Connect(
                            id,
                            Args.Text(request, "host"),
                            Args.Int(request, "port"),
                            Args.Text(request, "fiscalRegNo"),
                            Args.OptionalText(request, "logDir"),
                            Args.Int(request, "connectTimeoutMs", 5000));
                    case "disconnect":
                        device.Disconnect();
                        return Reply.Ok(id);
                    case "version":
                        return device.Versions(id);
                    case "status":
                        return device.Call(id, p => p.CheckPrinterStatus());
                    case "lastDocument":
                        {
                            var lastZ = Args.Bool(request, "lastZ");
                            return device.Call(id, p => p.GetLastDocumentInfo(lastZ));
                        }
                    case "vatRate":
                        {
                            var index = Args.Int(request, "index", 0, 7);
                            return device.Call(id, p => p.GetVATRate(index));
                        }
                    case "department":
                        {
                            var deptId = Args.Int(request, "deptId", 1, 8);
                            return device.Call(id, p => p.GetDepartment(deptId));
                        }
                    case "printDeptOnly":
                        {
                            var document = Args.Document(request, "document");
                            return device.Call(id, p => p.PrintJSONDocumentDeptOnly(document));
                        }
                    case "eft":
                        {
                            var amount = Args.Amount(request, "amount");
                            var installment = Args.Int(request, "installment", 0, 12);
                            return device.Call(id, p => p.GetEFTAuthorisation(amount, installment, string.Empty));
                        }
                    case "closeReceipt":
                        {
                            var slipCopy = Args.Bool(request, "slipCopy");
                            return device.Call(id, p => p.CloseReceipt(slipCopy));
                        }
                    case "voidReceipt":
                        return device.Call(id, p => p.VoidReceipt());
                    case "dailySummary":
                        // Başarılıysa düz JSON döner, değilse "hata|durum".
                        return device.Call(id, p => p.GetDailySummary());
                    case "zReport":
                        return device.Call(id, p => p.PrintZReport());
                    case "clearError":
                        return device.Call(id, p => p.ClearError());
                    default:
                        return Reply.Usage(id, "Bilinmeyen komut");
                }
            }
            catch (UsageException e)
            {
                return Reply.Usage(id, e.Message);
            }
        }
    }

    internal sealed class Device : IDisposable
    {
        /// <summary>Hugin örneğinin değeri (FP300Service/Common.cs).</summary>
        private const int DefaultBufferSize = 2048;

        /// <summary>
        /// Hugin örneğinin soket okuma süresi (Connection.cs). Kart beklerken de
        /// aynı kalıyor; uzun bekleyişi kütüphane kendisi yönetiyor.
        /// </summary>
        private const int ReceiveTimeoutMs = 4500;

        /// <summary>Kütüphane günlüğü bu kadar gün tutulur — klasör bizim.</summary>
        private const int LogRetentionDays = 14;

        private ICompactPrinter printer;
        private Socket socket;

        /// <summary>
        /// Eşleme süreç ömrü boyunca bir kez yapılır; kopan bağlantı yalnızca
        /// soketi yeniler (Hugin örneği: `isMatchedBefore`). Başka cihaza
        /// geçilirse sıfırlanır.
        /// </summary>
        private string matchedKey;

        public JObject Connect(JToken id, string host, int port, string fiscalRegNo, string logDir, int connectTimeoutMs)
        {
            IPAddress address;
            if (!IPAddress.TryParse(host, out address) || address.AddressFamily != AddressFamily.InterNetwork)
            {
                // Yalnızca IPv4 adresi: ad çözümlemesi yok, ağda başka bir yere
                // yönlendirilemez.
                throw new UsageException("Geçersiz IP adresi");
            }
            if (port < 1 || port > 65535) throw new UsageException("Geçersiz port");
            if (!Regex.IsMatch(fiscalRegNo ?? string.Empty, "^[A-Za-z0-9]{6,12}$"))
            {
                throw new UsageException("Geçersiz sicil numarası");
            }
            if (connectTimeoutMs < 500 || connectTimeoutMs > 30000) throw new UsageException("Geçersiz süre");

            var key = address + ":" + port + "/" + fiscalRegNo.ToUpperInvariant();
            if (key != matchedKey)
            {
                matchedKey = null;
                printer = null;
            }

            try
            {
                OpenSocket(address, port, connectTimeoutMs, DefaultBufferSize);

                if (printer != null)
                {
                    printer.SetCommObject(socket);
                    return Reply.Ok(id, Info());
                }

                var candidate = new CompactPrinter();
                // Hugin: eşlemeden ÖNCE sicil numarası kütüphaneye verilir.
                candidate.FiscalRegisterNo = fiscalRegNo.ToUpperInvariant();
                if (!string.IsNullOrEmpty(logDir))
                {
                    Directory.CreateDirectory(logDir);
                    PruneLogs(logDir);
                    candidate.LogDirectory = logDir;
                }
                // 2 = ERROR. Ayrıntılı seviyeler fiş içeriğini ve kart
                // işleminin ayrıntısını günlüğe yazıyor; ihtiyacımız yok.
                candidate.LogerLevel = 2;

                if (!candidate.Connect(socket, DeviceInfoFor(port, fiscalRegNo)))
                {
                    var detail = SafeLastResponse(candidate);
                    Close();
                    return Reply.Fail(id, "match", "Yazarkasa eşleşmeyi kabul etmedi", detail);
                }

                // Hugin örneğiyle aynı sıra: cihazın tampon boyutu farklıysa
                // soket o boyutla yeniden açılır, sonra kütüphaneye verilir.
                var bufferSize = candidate.PrinterBufferSize;
                if (bufferSize > 0 && bufferSize != socket.SendBufferSize)
                {
                    OpenSocket(address, port, connectTimeoutMs, bufferSize);
                }
                candidate.SetCommObject(socket);

                printer = candidate;
                matchedKey = key;
                return Reply.Ok(id, Info());
            }
            catch (SocketException e)
            {
                Close();
                return Reply.Fail(id, "transport", "Yazarkasaya bağlanılamadı (" + e.SocketErrorCode + ")");
            }
            catch (Exception e)
            {
                Close();
                return Reply.Fail(id, "transport", e.GetType().Name + ": " + e.Message);
            }
        }

        public JObject Call(JToken id, Func<ICompactPrinter, string> call)
        {
            if (printer == null || socket == null || !socket.Connected)
            {
                return Reply.Fail(id, "not_connected", "Yazarkasaya bağlı değil");
            }

            string raw;
            try
            {
                raw = call(printer);
            }
            catch (Exception e)
            {
                // İstek cihaza gitti ve cevap kayboldu. Soket kapanır, eşleme
                // kalır: bir sonraki bağlantı yalnızca soketi yeniler.
                Close();
                return Reply.Fail(id, "transport", e.GetType().Name + ": " + e.Message);
            }

            if (string.IsNullOrEmpty(raw))
            {
                Close();
                return Reply.Fail(id, "transport", "Yazarkasa cevap vermedi");
            }
            return Reply.Ok(id, new JObject { ["raw"] = raw });
        }

        public JObject Versions(JToken id)
        {
            var reply = Call(id, p => p.GetECRVersion());
            if (printer != null) reply["library"] = SafeLibraryVersion(printer);
            return reply;
        }

        public void Disconnect()
        {
            Close();
        }

        public void Dispose()
        {
            Close();
        }

        private JObject Info()
        {
            return new JObject
            {
                ["library"] = SafeLibraryVersion(printer),
                ["bufferSize"] = socket != null ? socket.SendBufferSize : 0,
            };
        }

        private void OpenSocket(IPAddress address, int port, int connectTimeoutMs, int bufferSize)
        {
            Close();
            var next = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)
            {
                ReceiveTimeout = ReceiveTimeoutMs,
                ReceiveBufferSize = bufferSize,
                SendBufferSize = bufferSize,
            };
            var pending = next.BeginConnect(new IPEndPoint(address, port), null, null);
            if (!pending.AsyncWaitHandle.WaitOne(connectTimeoutMs))
            {
                next.Close();
                throw new SocketException((int)SocketError.TimedOut);
            }
            next.EndConnect(pending);
            socket = next;
        }

        private void Close()
        {
            var current = socket;
            socket = null;
            if (current == null) return;
            try
            {
                if (current.Connected) current.Shutdown(SocketShutdown.Both);
            }
            catch (SocketException)
            {
                // Zaten kopmuş.
            }
            current.Close();
        }

        /// <summary>
        /// Hugin örneğindeki eşleme bilgisi (MainForm.MatchExDevice), tek farkla:
        /// IP, cihaza AÇILAN soketin yerel adresi — örnek, makinenin adres
        /// listesindeki son IPv4'ü alıyordu ve birden çok ağ kartında yanlış
        /// adresi verebiliyordu.
        /// </summary>
        private DeviceInfo DeviceInfoFor(int port, string fiscalRegNo)
        {
            var local = (IPEndPoint)socket.LocalEndPoint;
            return new DeviceInfo
            {
                IP = local.Address,
                IPProtocol = IPProtocol.IPV4,
                Brand = "HUGIN",
                Model = "HUGIN COMPACT",
                Port = port,
                TerminalNo = fiscalRegNo.ToUpperInvariant().PadLeft(8, '0'),
                Version = new FileInfo(Assembly.GetExecutingAssembly().Location).LastWriteTime.ToShortDateString(),
                SerialNum = MachineSerial(),
            };
        }

        /// <summary>
        /// Bu bilgisayarın SABİT kimliği — cihaz eşlemeyi buna bağlıyor.
        ///
        /// Hugin örneği: anakart seri numarasının MD5'inin ilk 8 hanesi. Okunamazsa
        /// örnek sabit "ABCD1234" veriyordu; o, her bilgisayarı aynı cihaz
        /// gösterirdi. Burada makine adının özeti kullanılıyor.
        /// </summary>
        private static string MachineSerial()
        {
            string source = null;
            try
            {
                using (var searcher = new System.Management.ManagementObjectSearcher("SELECT SerialNumber FROM Win32_BaseBoard"))
                {
                    foreach (var item in searcher.Get())
                    {
                        source = item["SerialNumber"] as string;
                    }
                }
            }
            catch (Exception)
            {
                source = null;
            }
            if (string.IsNullOrWhiteSpace(source)) source = Environment.MachineName;
            return Md5Hex(source).Substring(0, 8);
        }

        private static string Md5Hex(string input)
        {
            using (var md5 = MD5.Create())
            {
                var hash = md5.ComputeHash(Encoding.ASCII.GetBytes(input));
                return string.Concat(hash.Select(b => b.ToString("X2", CultureInfo.InvariantCulture)));
            }
        }

        private static void PruneLogs(string logDir)
        {
            var cutoff = DateTime.Now.AddDays(-LogRetentionDays);
            foreach (var file in Directory.GetFiles(logDir))
            {
                try
                {
                    if (File.GetLastWriteTime(file) < cutoff) File.Delete(file);
                }
                catch (IOException)
                {
                    // Kütüphane dosyayı açık tutuyor olabilir; bir sonraki açılışta.
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }

        private static string SafeLastResponse(ICompactPrinter p)
        {
            try
            {
                return p.GetLastResponse();
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string SafeLibraryVersion(ICompactPrinter p)
        {
            try
            {
                return p.LibraryVersion;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    internal sealed class UsageException : Exception
    {
        public UsageException(string message) : base(message)
        {
        }
    }

    internal static class Reply
    {
        public const string Version = "1.0.0";

        public static JObject Ok(JToken id, JObject extra = null)
        {
            var reply = new JObject { ["id"] = id, ["ok"] = true };
            if (extra != null)
            {
                foreach (var property in extra.Properties()) reply[property.Name] = property.Value;
            }
            return reply;
        }

        public static JObject Usage(JToken id, string error)
        {
            return Fail(id, "usage", error);
        }

        public static JObject Fail(JToken id, string kind, string error, string detail = null)
        {
            var reply = new JObject { ["id"] = id, ["ok"] = false, ["kind"] = kind, ["error"] = error };
            if (!string.IsNullOrEmpty(detail)) reply["detail"] = detail;
            return reply;
        }
    }

    /// <summary>
    /// İstek alanlarını okur ve SINIRLAR. Ajan güvenilir bir istemci ama
    /// sınırı burada da çekmek, cihaza giden her değerin bilinen bir biçimde
    /// olduğunu tek yerden garanti ediyor.
    /// </summary>
    internal static class Args
    {
        /// <summary>Fiş belgesi için üst sınır: 128 kalem bunun çok altında kalır.</summary>
        private const int MaxDocumentChars = 256 * 1024;

        public static string Text(JObject request, string name)
        {
            var token = request[name];
            if (token == null || token.Type != JTokenType.String) throw new UsageException(name + " eksik");
            return (string)token;
        }

        public static string OptionalText(JObject request, string name)
        {
            var token = request[name];
            if (token == null || token.Type == JTokenType.Null) return null;
            if (token.Type != JTokenType.String) throw new UsageException(name + " geçersiz");
            return (string)token;
        }

        public static int Int(JObject request, string name, int fallback)
        {
            var token = request[name];
            if (token == null || token.Type == JTokenType.Null) return fallback;
            if (token.Type != JTokenType.Integer) throw new UsageException(name + " geçersiz");
            return (int)token;
        }

        public static int Int(JObject request, string name)
        {
            var token = request[name];
            if (token == null || token.Type != JTokenType.Integer) throw new UsageException(name + " eksik");
            return (int)token;
        }

        public static int Int(JObject request, string name, int min, int max)
        {
            var value = Int(request, name);
            if (value < min || value > max) throw new UsageException(name + " aralık dışında");
            return value;
        }

        public static bool Bool(JObject request, string name)
        {
            var token = request[name];
            if (token == null || token.Type == JTokenType.Null) return false;
            if (token.Type != JTokenType.Boolean) throw new UsageException(name + " geçersiz");
            return (bool)token;
        }

        /// <summary>
        /// Tutar METİN olarak gelir ("125.50") ve kültürden bağımsız çözülür.
        /// Sayı olarak taşımak kayan nokta hatasına, Türkçe Windows'ta
        /// `decimal.Parse` ise virgül beklentisine açıktı.
        /// </summary>
        public static decimal Amount(JObject request, string name)
        {
            var text = Text(request, name);
            if (!Regex.IsMatch(text, @"^\d{1,6}(\.\d{1,2})?$")) throw new UsageException(name + " geçersiz");
            var value = decimal.Parse(text, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            if (value <= 0m) throw new UsageException(name + " geçersiz");
            return value;
        }

        public static string Document(JObject request, string name)
        {
            var token = request[name] as JObject;
            if (token == null) throw new UsageException(name + " eksik");
            var json = token.ToString(Formatting.None);
            if (json.Length > MaxDocumentChars) throw new UsageException(name + " çok büyük");
            return json;
        }
    }
}
