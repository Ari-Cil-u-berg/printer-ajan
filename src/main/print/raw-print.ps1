param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$FilePath,
  [string]$DocName = "Ari Adisyon Fis"
)

# Sends a file to a Windows printer with the RAW datatype, bypassing the driver's
# rendering path. Uses winspool.drv directly via P/Invoke — no native module to ship.

$ErrorActionPreference = "Stop"

$signature = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static void SendFile(string printerName, string filePath, string docName)
    {
        byte[] bytes = File.ReadAllBytes(filePath);
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());

        IntPtr unmanaged = IntPtr.Zero;
        try
        {
            DOCINFO di = new DOCINFO();
            di.pDocName = docName;
            di.pDataType = "RAW";

            if (!StartDocPrinter(hPrinter, 1, di))
                throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
            if (!StartPagePrinter(hPrinter))
                throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());

            unmanaged = Marshal.AllocCoTaskMem(bytes.Length);
            Marshal.Copy(bytes, 0, unmanaged, bytes.Length);

            int written;
            if (!WritePrinter(hPrinter, unmanaged, bytes.Length, out written))
                throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
            if (written != bytes.Length)
                throw new Exception("Short write: " + written + " of " + bytes.Length);

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
        }
        finally
        {
            if (unmanaged != IntPtr.Zero) Marshal.FreeCoTaskMem(unmanaged);
            ClosePrinter(hPrinter);
        }
    }
}
'@

Add-Type -TypeDefinition $signature -Language CSharp
[RawPrinter]::SendFile($PrinterName, $FilePath, $DocName)
Write-Output "OK"
