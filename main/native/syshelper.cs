// PS5 Game Launcher system helper.
//
// A tiny console program the launcher talks to over stdin/stdout (one JSON
// request per line, one JSON response per line). It exposes things Electron
// cannot reach on its own:
//   * now-playing media from any app (Windows media sessions), incl. cover art
//   * the system master volume / mute and the playback device (Core Audio)
//   * monitor brightness over DDC/CI, with a WMI fallback for laptop panels
//   * Bluetooth: radio on/off, paired devices, scanning, pairing and
//     connecting audio devices
//   * Windows Night Light on/off
//   * controller Guide/PS button + navigation for the in-game overlay
//   * running-game detection and closing games, foreground window handling
//
// Requests are handled on the thread pool, so a slow Bluetooth operation
// never blocks media updates.
//
// Built with the .NET Framework compiler that ships with Windows — see
// build.cmd in this folder.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Foundation;
using Windows.Media.Control;

// Version details shown in the file's Properties › Details.
[assembly: System.Reflection.AssemblyTitle("PS5 Game Launcher system helper")]
[assembly: System.Reflection.AssemblyProduct("PS5 Game Launcher")]
[assembly: System.Reflection.AssemblyCompany("Aris")]
[assembly: System.Reflection.AssemblyCopyright("Copyright (c) 2026 Aris")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace PS5GameLauncher
{
    static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        static readonly object WriteLock = new object();
        static StreamWriter stdout;

        [MTAThread]
        static void Main()
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) => GameWin.ResumeAll();
            AppDomain.CurrentDomain.ProcessExit += (s, e) => GameWin.ResumeAll();
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            stdout.WriteLine("{\"ready\":true}");
            Pad.Start();
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                var copy = line;
                ThreadPool.QueueUserWorkItem(_ => Process(copy));
            }
            BtScan.Stop();
            GameWin.ResumeAll();
        }

        /// <summary>Unsolicited event line (no id), e.g. a controller button.</summary>
        public static void Emit(Dictionary<string, object> evt)
        {
            var text = Json.Serialize(evt);
            lock (WriteLock) stdout.WriteLine(text);
        }

        static void Process(string line)
        {
            var res = new Dictionary<string, object>();
            object id = null;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                if (req.ContainsKey("id")) id = req["id"];
                res["data"] = Handle(req);
                res["ok"] = true;
            }
            catch (Exception e)
            {
                var inner = e is AggregateException && e.InnerException != null ? e.InnerException : e;
                res["ok"] = false;
                res["error"] = inner.Message;
            }
            res["id"] = id;
            var text = Json.Serialize(res);
            lock (WriteLock) stdout.WriteLine(text);
        }

        static string Str(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? v.ToString() : null;
        }

        static int Int(Dictionary<string, object> r, string k, int def)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : def;
        }

        static long Long(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v != null ? Convert.ToInt64(v) : 0;
        }

        static bool Bool(Dictionary<string, object> r, string k)
        {
            object v;
            return r.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        /// <summary>
        /// Start a program through the Windows shell. Unlike spawning from Node,
        /// nothing from the launcher (pipes, sockets) is inherited by the game,
        /// and games that need administrator rights get the normal UAC prompt.
        /// </summary>
        static object Launch(string file, string args, string cwd)
        {
            var psi = new System.Diagnostics.ProcessStartInfo(file)
            {
                Arguments = args ?? "",
                UseShellExecute = true,
                WorkingDirectory = string.IsNullOrEmpty(cwd) ? System.IO.Path.GetDirectoryName(file) : cwd,
            };
            using (var p = System.Diagnostics.Process.Start(psi))
            {
                return p == null ? 0 : p.Id;
            }
        }

        static object Handle(Dictionary<string, object> req)
        {
            switch (Str(req, "cmd"))
            {
                case "ping": return "pong";
                case "media": return Media.State(Str(req, "app"), Bool(req, "art"));
                case "mediaCmd": return Media.Command(Str(req, "app"), Str(req, "action"), Int(req, "value", 0));
                case "volume": return new Dictionary<string, object> { { "volume", Audio.GetVolume() }, { "muted", Audio.GetMute() } };
                case "setVolume": Audio.SetVolume(Int(req, "value", 50)); return true;
                case "setMute": Audio.SetMute(Bool(req, "value")); return true;
                case "audioOutputs": return Audio.Outputs();
                case "setAudioOutput": return Audio.SetOutput(Str(req, "device"));
                case "brightness": return Monitors.Get();
                case "setBrightness": return Monitors.Set(Int(req, "value", 50), Int(req, "index", -1));
                case "nightLight": return NightLight.Get();
                case "setNightLight": return NightLight.Set(Bool(req, "value"));
                case "bt": return Bluetooth.State();
                case "btRadio": return Bluetooth.SetRadio(Bool(req, "value"));
                case "btConnect": return Bluetooth.SetConnection(Str(req, "address"), true);
                case "btDisconnect": return Bluetooth.SetConnection(Str(req, "address"), false);
                case "btPair": return Bluetooth.Pair(Str(req, "device"));
                case "btUnpair": return Bluetooth.Unpair(Str(req, "device"));
                case "btScanStart": return BtScan.Start();
                case "btScan": return BtScan.Results();
                case "btScanStop": BtScan.Stop(); return true;
                case "procs": return Procs.List();
                case "procPath": return Procs.ImagePath(Int(req, "pid", 0));
                case "closeWindows": return Procs.CloseWindows(Int(req, "pid", 0));
                case "fgGet": return Fg.Get();
                case "fgSet": return Fg.Set(Long(req, "hwnd"));
                case "dirWindows": return Fg.DirWindows(req.ContainsKey("dirs") ? ((System.Collections.ArrayList)req["dirs"]).Cast<object>().Select(o => Convert.ToString(o)).ToList() : new List<string>());
                case "padForward": Pad.Forward = Bool(req, "value"); return true;
                case "padInfo": return Pad.Info();
                case "launch": return Launch(Str(req, "file"), Str(req, "args"), Str(req, "cwd"));
                case "windowTitles": return GameWin.Titles(Int(req, "pid", 0));
                case "focusProc": return GameWin.Focus(Int(req, "pid", 0));
                case "suspend": if (Bool(req, "wait")) Pad.WaitIdle(1500); return GameWin.Suspend(Int(req, "pid", 0), true);
                case "resume": if (Bool(req, "wait")) Pad.WaitIdle(1500); return GameWin.Suspend(Int(req, "pid", 0), false);
                case "resumeAll": GameWin.ResumeAll(); return true;
                case "netConns": return Net.Established(Int(req, "pid", 0));
                default: throw new ArgumentException("unknown command");
            }
        }
    }

    static class Async
    {
        public static T Await<T>(IAsyncOperation<T> op, int timeoutMs)
        {
            using (var done = new ManualResetEvent(false))
            {
                op.Completed = (info, status) => done.Set();
                if (op.Status == AsyncStatus.Started && !done.WaitOne(timeoutMs)) throw new TimeoutException("request timed out");
                if (op.Status == AsyncStatus.Error) throw new Exception(op.ErrorCode.Message, op.ErrorCode);
                if (op.Status == AsyncStatus.Canceled) throw new OperationCanceledException();
                return op.GetResults();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Media sessions                                                      */
    /* ------------------------------------------------------------------ */

    static class Media
    {
        static GlobalSystemMediaTransportControlsSessionManager mgr;

        static readonly object Gate = new object();

        static T Await<T>(IAsyncOperation<T> op)
        {
            return Async.Await(op, 5000);
        }

        static GlobalSystemMediaTransportControlsSessionManager Manager()
        {
            lock (Gate)
            {
                if (mgr == null) mgr = Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
                return mgr;
            }
        }

        static bool IsPlaying(GlobalSystemMediaTransportControlsSession s)
        {
            return s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        }

        // The requested app if it has a session, else something that is playing
        // (preferring Windows' "current" session), else the current session.
        static GlobalSystemMediaTransportControlsSession Pick(string app)
        {
            var sessions = Manager().GetSessions().ToList();
            if (sessions.Count == 0) return null;
            if (!string.IsNullOrEmpty(app))
            {
                var hit = sessions.FirstOrDefault(s => s.SourceAppUserModelId == app);
                if (hit != null) return hit;
            }
            var cur = Manager().GetCurrentSession();
            if (cur != null && IsPlaying(cur)) return cur;
            var playing = sessions.FirstOrDefault(IsPlaying);
            if (playing != null) return playing;
            return cur ?? sessions[0];
        }

        public static object State(string app, bool withArt)
        {
            var d = new Dictionary<string, object>();
            var list = new List<object>();
            foreach (var x in Manager().GetSessions())
            {
                list.Add(new Dictionary<string, object> { { "app", x.SourceAppUserModelId }, { "status", x.GetPlaybackInfo().PlaybackStatus.ToString() } });
            }
            d["sessions"] = list;
            var s = Pick(app);
            if (s == null)
            {
                d["active"] = false;
                return d;
            }
            var p = Await(s.TryGetMediaPropertiesAsync());
            var pb = s.GetPlaybackInfo();
            var tl = s.GetTimelineProperties();
            d["active"] = true;
            d["app"] = s.SourceAppUserModelId;
            d["title"] = p.Title;
            d["artist"] = string.IsNullOrEmpty(p.Artist) ? p.AlbumArtist : p.Artist;
            d["album"] = p.AlbumTitle;
            d["status"] = pb.PlaybackStatus.ToString();
            d["canPrev"] = pb.Controls.IsPreviousEnabled;
            d["canNext"] = pb.Controls.IsNextEnabled;
            d["canToggle"] = pb.Controls.IsPlayPauseToggleEnabled;
            d["canSeek"] = pb.Controls.IsPlaybackPositionEnabled;
            d["position"] = tl.Position.TotalSeconds;
            d["duration"] = (tl.EndTime - tl.StartTime).TotalSeconds;
            d["updated"] = tl.LastUpdatedTime.ToUnixTimeMilliseconds();
            d["key"] = p.Title + "|" + p.Artist + "|" + p.AlbumTitle;
            if (withArt && p.Thumbnail != null)
            {
                try
                {
                    var st = Await(p.Thumbnail.OpenReadAsync());
                    using (var reader = new Windows.Storage.Streams.DataReader(st))
                    {
                        var n = Await(reader.LoadAsync((uint)st.Size));
                        var bytes = new byte[n];
                        reader.ReadBytes(bytes);
                        var type = string.IsNullOrEmpty(st.ContentType) ? "image/png" : st.ContentType;
                        d["art"] = "data:" + type + ";base64," + Convert.ToBase64String(bytes);
                    }
                    st.Dispose();
                }
                catch { }
            }
            return d;
        }

        public static bool Command(string app, string action, int value)
        {
            var s = Pick(app);
            if (s == null) return false;
            switch (action)
            {
                case "toggle": return Await(s.TryTogglePlayPauseAsync());
                case "play": return Await(s.TryPlayAsync());
                case "pause": return Await(s.TryPauseAsync());
                case "next": return Await(s.TrySkipNextAsync());
                case "prev": return Await(s.TrySkipPreviousAsync());
                case "seek": return Await(s.TryChangePlaybackPositionAsync((long)value * 10000000L));
            }
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* System volume (Core Audio)                                          */
    /* ------------------------------------------------------------------ */

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr p);
        int UnregisterControlChangeNotify(IntPtr p);
        int GetChannelCount(out uint c);
        int SetMasterVolumeLevel(float l, ref Guid ctx);
        int SetMasterVolumeLevelScalar(float l, ref Guid ctx);
        int GetMasterVolumeLevel(out float l);
        int GetMasterVolumeLevelScalar(out float l);
        int SetChannelVolumeLevel(uint ch, float l, ref Guid ctx);
        int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
        int GetChannelVolumeLevel(uint ch, out float l);
        int GetChannelVolumeLevelScalar(uint ch, out float l);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        int GetCount(out uint count);
        int Item(uint index, out IMMDevice device);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }

    [Guid("2A07407E-6497-4A18-9787-32F79BD0D98F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDeviceTopology
    {
        int GetConnectorCount(out uint count);
        int GetConnector(uint index, out IConnector connector);
    }

    [Guid("9C2C4058-23F5-41DE-877A-DF3AF236A09E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IConnector
    {
        int GetType(out int type);
        int GetDataFlow(out int flow);
        int ConnectTo(IConnector other);
        int Disconnect();
        int IsConnected([MarshalAs(UnmanagedType.Bool)] out bool connected);
        int GetConnectedTo(out IConnector other);
        int GetConnectorIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetDeviceIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KSPROPERTY
    {
        public Guid Set;
        public uint Id;
        public uint Flags;
    }

    [Guid("28F54685-06FD-11D2-B27A-00A0C9223196"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IKsControl
    {
        [PreserveSig] int KsProperty(ref KSPROPERTY prop, uint propLen, IntPtr data, uint dataLen, out uint returned);
        [PreserveSig] int KsMethod(IntPtr method, uint methodLen, IntPtr data, uint dataLen, out uint returned);
        [PreserveSig] int KsEvent(IntPtr evt, uint evtLen, IntPtr data, uint dataLen, out uint returned);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT
    {
        public ushort vt;
        public ushort r1, r2, r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint count);
        int GetAt(uint index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    // Not in the SDK, but stable since Windows 7: the interface Windows' own
    // Sound settings use to change the default playback device. Only
    // SetDefaultEndpoint is called; the slots before it keep the vtable order.
    [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        int GetMixFormat(IntPtr a, IntPtr b);
        int GetDeviceFormat(IntPtr a, int b, IntPtr c);
        int ResetDeviceFormat(IntPtr a);
        int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
        int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
        int SetProcessingPeriod(IntPtr a, IntPtr b);
        int GetShareMode(IntPtr a, IntPtr b);
        int SetShareMode(IntPtr a, IntPtr b);
        int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
        int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        int SetEndpointVisibility(IntPtr a, int b);
    }

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClient { }

    static class Audio
    {
        static IAudioEndpointVolume Endpoint()
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDevice dev;
            Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
            var iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
            return (IAudioEndpointVolume)o;
        }

        public static int GetVolume()
        {
            float v;
            Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
            return (int)Math.Round(v * 100);
        }

        public static void SetVolume(int percent)
        {
            var g = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, ref g));
        }

        public static bool GetMute()
        {
            bool m;
            Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
            return m;
        }

        public static void SetMute(bool mute)
        {
            var g = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref g));
        }

        static readonly Guid PkeyDevice = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
        static readonly Guid PkeyInterface = new Guid("026E516E-B814-414B-83CD-856D6FEF4822");

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pv);

        static string Prop(IPropertyStore store, Guid fmtid, int pid)
        {
            var key = new PROPERTYKEY { fmtid = fmtid, pid = pid };
            PROPVARIANT v;
            if (store.GetValue(ref key, out v) != 0) return null;
            try
            {
                return v.vt == 31 /* VT_LPWSTR */ ? Marshal.PtrToStringUni(v.p) : null;
            }
            finally
            {
                PropVariantClear(ref v);
            }
        }

        /// <summary>Active playback devices, e.g. "Speakers (Realtek(R) Audio)".</summary>
        public static List<Dictionary<string, object>> Outputs()
        {
            var list = new List<Dictionary<string, object>>();
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            string def = null;
            IMMDevice d;
            if (en.GetDefaultAudioEndpoint(0, 1, out d) == 0) d.GetId(out def);
            IMMDeviceCollection col;
            Marshal.ThrowExceptionForHR(en.EnumAudioEndpoints(0 /* render */, 1 /* active */, out col));
            uint count;
            col.GetCount(out count);
            for (uint i = 0; i < count; i++)
            {
                try
                {
                    IMMDevice dev;
                    if (col.Item(i, out dev) != 0) continue;
                    string id;
                    dev.GetId(out id);
                    string name = null, desc = null, adapter = null;
                    IntPtr ps;
                    if (dev.OpenPropertyStore(0 /* read */, out ps) == 0 && ps != IntPtr.Zero)
                    {
                        try
                        {
                            var store = (IPropertyStore)Marshal.GetObjectForIUnknown(ps);
                            name = Prop(store, PkeyDevice, 14); // Device_FriendlyName
                            desc = Prop(store, PkeyDevice, 2); // Device_DeviceDesc
                            adapter = Prop(store, PkeyInterface, 2); // DeviceInterface_FriendlyName
                        }
                        finally
                        {
                            Marshal.Release(ps);
                        }
                    }
                    list.Add(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "name", name ?? desc ?? id },
                        { "desc", desc ?? "" },
                        { "adapter", adapter ?? "" },
                        { "default", id == def },
                    });
                }
                catch { }
            }
            return list;
        }

        /// <summary>Make a device the default for every role (console, multimedia, communications).</summary>
        public static bool SetOutput(string id)
        {
            if (string.IsNullOrEmpty(id)) throw new ArgumentException("id required");
            var pc = (IPolicyConfig)new PolicyConfigClient();
            for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(pc.SetDefaultEndpoint(id, role));
            return true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Monitor brightness (DDC/CI + WMI fallback)                          */
    /* ------------------------------------------------------------------ */

    static class Monitors
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PHYSICAL_MONITOR
        {
            public IntPtr hPhysicalMonitor;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription;
        }

        delegate bool EnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc proc, IntPtr data);
        [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);
        [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
        [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);
        [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, out uint type, out uint current, out uint max);
        [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte code, uint value);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct MONITORINFOEX
        {
            public int cbSize;
            public int l, t, r, b, wl, wt, wr, wb;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
        [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, IntPtr topology);
        [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr packet);

        /// <summary>
        /// GDI device name (DISPLAY1, DISPLAY2, ...) -> the monitor's own name from its
        /// EDID ("PL2730H"), the name Windows shows in Display settings.
        /// </summary>
        static Dictionary<string, string> FriendlyNames()
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            const int PathSize = 72, ModeSize = 64;
            uint np, nm;
            if (GetDisplayConfigBufferSizes(2 /* QDC_ONLY_ACTIVE_PATHS */, out np, out nm) != 0 || np == 0) return map;
            IntPtr paths = Marshal.AllocHGlobal((int)np * PathSize), modes = Marshal.AllocHGlobal((int)nm * ModeSize);
            IntPtr src = Marshal.AllocHGlobal(84), tgt = Marshal.AllocHGlobal(420);
            try
            {
                if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return map;
                for (int i = 0; i < np; i++)
                {
                    IntPtr p = paths + i * PathSize;
                    // Source: adapter LUID at +0, id at +8. Target: LUID at +20, id at +28.
                    Header(src, 1 /* GET_SOURCE_NAME */, 84, p, 0);
                    Header(tgt, 2 /* GET_TARGET_NAME */, 420, p, 20);
                    if (DisplayConfigGetDeviceInfo(src) != 0 || DisplayConfigGetDeviceInfo(tgt) != 0) continue;
                    var gdi = Marshal.PtrToStringUni(src + 20);
                    var name = Marshal.PtrToStringUni(tgt + 36);
                    if (!string.IsNullOrEmpty(gdi) && !string.IsNullOrEmpty(name)) map[gdi] = name;
                }
            }
            catch { }
            finally
            {
                Marshal.FreeHGlobal(paths);
                Marshal.FreeHGlobal(modes);
                Marshal.FreeHGlobal(src);
                Marshal.FreeHGlobal(tgt);
            }
            return map;
        }

        static void Header(IntPtr packet, int type, int size, IntPtr path, int offset)
        {
            for (int i = 0; i < size; i += 4) Marshal.WriteInt32(packet, i, 0);
            Marshal.WriteInt32(packet, 0, type);
            Marshal.WriteInt32(packet, 4, size);
            Marshal.WriteInt64(packet, 8, Marshal.ReadInt64(path, offset));
            Marshal.WriteInt32(packet, 16, Marshal.ReadInt32(path, offset + 8));
        }

        class Group
        {
            public string Name;
            public PHYSICAL_MONITOR[] Monitors;
        }

        static List<Group> Open()
        {
            var handles = new List<IntPtr>();
            EnumProc cb = (h, dc, r, d) => { handles.Add(h); return true; };
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            var names = FriendlyNames();
            var result = new List<Group>();
            foreach (var h in handles)
            {
                uint n;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(h, out n) || n == 0) continue;
                var arr = new PHYSICAL_MONITOR[n];
                if (!GetPhysicalMonitorsFromHMONITOR(h, n, arr)) continue;
                var info = new MONITORINFOEX { cbSize = Marshal.SizeOf(typeof(MONITORINFOEX)) };
                string name = null;
                if (GetMonitorInfo(h, ref info) && info.szDevice != null) names.TryGetValue(info.szDevice, out name);
                result.Add(new Group { Name = name, Monitors = arr });
            }
            return result;
        }

        public static List<object> Get()
        {
            var list = new List<object>();
            foreach (var g in Open())
            {
                var arr = g.Monitors;
                foreach (var m in arr)
                {
                    uint type, cur, max;
                    if (GetVCPFeatureAndVCPFeatureReply(m.hPhysicalMonitor, 0x10, out type, out cur, out max) && max > 0)
                    {
                        var desc = m.szPhysicalMonitorDescription;
                        var generic = string.IsNullOrEmpty(desc) || desc.IndexOf("Generic", StringComparison.OrdinalIgnoreCase) >= 0;
                        list.Add(new Dictionary<string, object> {
                            { "name", arr.Length == 1 && !string.IsNullOrEmpty(g.Name) ? g.Name : generic ? (g.Name ?? "") : desc },
                            { "percent", (int)Math.Round(cur * 100.0 / max) },
                            { "method", "ddc" },
                        });
                    }
                }
                DestroyPhysicalMonitors((uint)arr.Length, arr);
            }
            if (list.Count == 0)
            {
                try
                {
                    using (var q = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                    {
                        foreach (ManagementObject o in q.Get())
                        {
                            list.Add(new Dictionary<string, object> {
                                { "name", "Built-in display" },
                                { "percent", Convert.ToInt32(o["CurrentBrightness"]) },
                                { "method", "wmi" },
                            });
                            break;
                        }
                    }
                }
                catch { }
            }
            return list;
        }

        public static int Set(int percent, int index)
        {
            percent = Math.Max(0, Math.Min(100, percent));
            int ok = 0, i = -1;
            foreach (var g in Open())
            {
                var arr = g.Monitors;
                foreach (var m in arr)
                {
                    uint type, cur, max;
                    if (!GetVCPFeatureAndVCPFeatureReply(m.hPhysicalMonitor, 0x10, out type, out cur, out max) || max == 0) continue;
                    i++;
                    if (index >= 0 && index != i) continue;
                    var v = (uint)Math.Round(percent * max / 100.0);
                    if (v == cur || SetVCPFeature(m.hPhysicalMonitor, 0x10, v)) ok++;
                }
                DestroyPhysicalMonitors((uint)arr.Length, arr);
            }
            if (ok == 0)
            {
                try
                {
                    using (var q = new ManagementObjectSearcher("root\\WMI", "SELECT * FROM WmiMonitorBrightnessMethods"))
                    {
                        foreach (ManagementObject o in q.Get())
                        {
                            o.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)percent });
                            ok = 1;
                            break;
                        }
                    }
                }
                catch { }
            }
            return ok;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Bluetooth                                                           */
    /* ------------------------------------------------------------------ */

    static class Bluetooth
    {
        const string ProtoClassic = "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}";
        const string ProtoLe = "{bb7bb05e-5972-42b5-94fc-76eaa7084d49}";
        static readonly Guid KsPropSetBtAudio = new Guid("7FA06C40-B8F6-4C7E-8556-E8C33A12E54D");

        public static readonly string[] Props =
        {
            "System.Devices.Aep.DeviceAddress",
            "System.Devices.Aep.IsConnected",
            "System.Devices.Aep.IsPaired",
            "System.Devices.Aep.Bluetooth.Cod.Major",
            "System.Devices.Aep.Bluetooth.Cod.Minor",
            "System.Devices.Aep.ProtocolId",
            "System.Devices.Aep.SignalStrength",
        };

        public static string Aqs(bool paired)
        {
            return "(System.Devices.Aep.ProtocolId:=\"" + ProtoClassic + "\" OR System.Devices.Aep.ProtocolId:=\"" + ProtoLe +
                   "\") AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#" + (paired ? "True" : "False");
        }

        static Radio FindRadio()
        {
            Async.Await(Radio.RequestAccessAsync(), 5000);
            var radios = Async.Await(Radio.GetRadiosAsync(), 5000);
            return radios.FirstOrDefault(r => r.Kind == RadioKind.Bluetooth);
        }

        static object Prop(DeviceInformation i, string key)
        {
            object v;
            return i.Properties.TryGetValue(key, out v) ? v : null;
        }

        public static string Norm(string address)
        {
            return (address ?? "").Replace(":", "").Replace("-", "").ToLowerInvariant();
        }

        static string Kind(string name, int major, int minor)
        {
            var n = (name ?? "").ToLowerInvariant();
            if (n.Contains("controller") || n.Contains("dualsense") || n.Contains("dualshock") || n.Contains("xbox") || n.Contains("gamepad") || n.Contains("joy-con")) return "gamepad";
            if (major == 4 || n.Contains("headphone") || n.Contains("headset") || n.Contains("speaker") || n.Contains("buds") || n.Contains("airpods") || n.Contains("jbl") || n.Contains("soundbar")) return "audio";
            if (major == 5)
            {
                if ((minor & 0x0F) == 1 || (minor & 0x0F) == 2) return "gamepad";
                if ((minor & 0x30) == 0x10) return "keyboard";
                if ((minor & 0x30) == 0x20) return "mouse";
                return "input";
            }
            if (n.Contains("keyboard")) return "keyboard";
            if (n.Contains("mouse")) return "mouse";
            if (major == 2 || n.Contains("phone")) return "phone";
            if (major == 1) return "computer";
            return "other";
        }

        public static Dictionary<string, object> Describe(DeviceInformation i, HashSet<string> audio)
        {
            var addr = Convert.ToString(Prop(i, "System.Devices.Aep.DeviceAddress") ?? "");
            var connected = Prop(i, "System.Devices.Aep.IsConnected") as bool? ?? false;
            var major = Convert.ToInt32(Prop(i, "System.Devices.Aep.Bluetooth.Cod.Major") ?? 0);
            var minor = Convert.ToInt32(Prop(i, "System.Devices.Aep.Bluetooth.Cod.Minor") ?? 0);
            var proto = Convert.ToString(Prop(i, "System.Devices.Aep.ProtocolId") ?? "").ToLowerInvariant();
            var signal = Prop(i, "System.Devices.Aep.SignalStrength");
            return new Dictionary<string, object>
            {
                { "id", i.Id },
                { "name", i.Name },
                { "address", addr },
                { "connected", connected },
                { "le", proto.Contains("bb7bb05e") },
                { "kind", Kind(i.Name, major, minor) },
                { "audio", audio != null && audio.Contains(Norm(addr)) },
                { "signal", signal == null ? null : (object)Convert.ToInt32(signal) },
            };
        }

        static string Hex(ulong address)
        {
            return address.ToString("x12");
        }

        static string Colons(string hex)
        {
            var parts = new List<string>();
            for (var i = 0; i + 1 < hex.Length; i += 2) parts.Add(hex.Substring(i, 2));
            return string.Join(":", parts);
        }

        static string Kind(string name, Windows.Devices.Bluetooth.BluetoothMajorClass major, int minor)
        {
            return Kind(name, (int)major, minor);
        }

        public static object State()
        {
            var d = new Dictionary<string, object>();
            Radio radio = null;
            try { radio = FindRadio(); } catch { }
            d["available"] = radio != null;
            d["on"] = radio != null && radio.State == RadioState.On;
            d["radio"] = radio != null ? radio.State.ToString() : "None";
            var list = new List<object>();
            if (radio != null)
            {
                HashSet<string> audio;
                try { audio = new HashSet<string>(AudioFilters().Select(f => f["address"] as string).Where(a => !string.IsNullOrEmpty(a))); }
                catch { audio = new HashSet<string>(); }
                var names = new HashSet<string>();

                // Classic Bluetooth (speakers, headsets, controllers, keyboards…)
                var classic = Async.Await(DeviceInformation.FindAllAsync(Windows.Devices.Bluetooth.BluetoothDevice.GetDeviceSelectorFromPairingState(true)), 8000);
                foreach (var info in classic)
                {
                    try
                    {
                        var dev = Async.Await(Windows.Devices.Bluetooth.BluetoothDevice.FromIdAsync(info.Id), 5000);
                        if (dev == null || string.IsNullOrWhiteSpace(dev.Name)) continue;
                        var hex = Hex(dev.BluetoothAddress);
                        names.Add(dev.Name);
                        list.Add(new Dictionary<string, object>
                        {
                            { "id", info.Id },
                            { "name", dev.Name },
                            { "address", Colons(hex) },
                            { "connected", dev.ConnectionStatus == Windows.Devices.Bluetooth.BluetoothConnectionStatus.Connected },
                            { "le", false },
                            { "kind", Kind(dev.Name, dev.ClassOfDevice.MajorClass, (int)dev.ClassOfDevice.RawValue >> 2 & 0x3F) },
                            { "audio", audio.Contains(hex) },
                        });
                        dev.Dispose();
                    }
                    catch { }
                }

                // Bluetooth LE (mice, keyboards, some headphones)
                try
                {
                    var le = Async.Await(DeviceInformation.FindAllAsync(Windows.Devices.Bluetooth.BluetoothLEDevice.GetDeviceSelectorFromPairingState(true)), 8000);
                    foreach (var info in le)
                    {
                        try
                        {
                            var dev = Async.Await(Windows.Devices.Bluetooth.BluetoothLEDevice.FromIdAsync(info.Id), 5000);
                            if (dev == null || string.IsNullOrWhiteSpace(dev.Name) || names.Contains(dev.Name)) continue;
                            var hex = Hex(dev.BluetoothAddress);
                            list.Add(new Dictionary<string, object>
                            {
                                { "id", info.Id },
                                { "name", dev.Name },
                                { "address", Colons(hex) },
                                { "connected", dev.ConnectionStatus == Windows.Devices.Bluetooth.BluetoothConnectionStatus.Connected },
                                { "le", true },
                                { "kind", Kind(dev.Name, 0, 0) },
                                { "audio", audio.Contains(hex) },
                            });
                            dev.Dispose();
                        }
                        catch { }
                    }
                }
                catch { }
            }
            d["devices"] = list;
            return d;
        }

        public static object SetRadio(bool on)
        {
            var radio = FindRadio();
            if (radio == null) throw new InvalidOperationException("No Bluetooth adapter found");
            return Async.Await(radio.SetStateAsync(on ? RadioState.On : RadioState.Off), 15000).ToString();
        }

        static DeviceInformation Info(string id)
        {
            return Async.Await(DeviceInformation.CreateFromIdAsync(id, Props, DeviceInformationKind.AssociationEndpoint), 10000);
        }

        public static object Pair(string id)
        {
            var info = Info(id);
            if (info.Pairing.IsPaired) return "AlreadyPaired";
            var custom = info.Pairing.Custom;
            TypedEventHandler<DeviceInformationCustomPairing, DevicePairingRequestedEventArgs> handler = (sender, args) =>
            {
                if (args.PairingKind == DevicePairingKinds.ProvidePin) args.Accept("0000");
                else args.Accept();
            };
            custom.PairingRequested += handler;
            try
            {
                var kinds = DevicePairingKinds.ConfirmOnly | DevicePairingKinds.DisplayPin | DevicePairingKinds.ProvidePin | DevicePairingKinds.ConfirmPinMatch;
                return Async.Await(custom.PairAsync(kinds), 60000).Status.ToString();
            }
            finally
            {
                custom.PairingRequested -= handler;
            }
        }

        public static object Unpair(string id)
        {
            DeviceInformation info = null;
            try
            {
                var dev = Async.Await(Windows.Devices.Bluetooth.BluetoothDevice.FromIdAsync(id), 5000);
                if (dev != null) info = dev.DeviceInformation;
            }
            catch { }
            if (info == null)
            {
                try
                {
                    var le = Async.Await(Windows.Devices.Bluetooth.BluetoothLEDevice.FromIdAsync(id), 5000);
                    if (le != null) info = le.DeviceInformation;
                }
                catch { }
            }
            if (info == null) info = Info(id);
            return Async.Await(info.Pairing.UnpairAsync(), 30000).Status.ToString();
        }

        // Bluetooth audio endpoints and the KS filter behind each one. The filter's
        // device path contains the Bluetooth address of the speaker/headset.
        public static List<Dictionary<string, object>> AudioFilters()
        {
            var result = new List<Dictionary<string, object>>();
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(2, 0x1 | 0x4 | 0x8, out col) != 0) return result;
            uint count;
            col.GetCount(out count);
            var seen = new HashSet<string>();
            for (uint i = 0; i < count; i++)
            {
                try
                {
                    IMMDevice dev;
                    if (col.Item(i, out dev) != 0) continue;
                    var iid = typeof(IDeviceTopology).GUID;
                    object o;
                    if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
                    var topo = (IDeviceTopology)o;
                    IConnector conn;
                    if (topo.GetConnector(0, out conn) != 0) continue;
                    string ksId;
                    if (conn.GetDeviceIdConnectedTo(out ksId) != 0 || string.IsNullOrEmpty(ksId)) continue;
                    var low = ksId.ToLowerInvariant();
                    if (!low.Contains("bth") || !seen.Add(low)) continue;
                    var m = System.Text.RegularExpressions.Regex.Match(low, "[#&_]([0-9a-f]{12})(?:_|#|&|$)");
                    int state;
                    dev.GetState(out state);
                    result.Add(new Dictionary<string, object> { { "ks", ksId }, { "address", m.Success ? m.Groups[1].Value : "" }, { "state", state } });
                }
                catch { }
            }
            return result;
        }

        public static int SetConnection(string address, bool connect)
        {
            var key = Norm(address);
            if (key.Length == 0) throw new ArgumentException("address required");
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            int sent = 0;
            foreach (var f in AudioFilters())
            {
                if ((string)f["address"] != key) continue;
                IMMDevice ks;
                if (en.GetDevice((string)f["ks"], out ks) != 0) continue;
                var iid = typeof(IKsControl).GUID;
                object o;
                if (ks.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
                var ctl = (IKsControl)o;
                var prop = new KSPROPERTY { Set = KsPropSetBtAudio, Id = connect ? 0u : 1u, Flags = 1 /* KSPROPERTY_TYPE_GET */ };
                uint ret;
                if (ctl.KsProperty(ref prop, (uint)Marshal.SizeOf(typeof(KSPROPERTY)), IntPtr.Zero, 0, out ret) >= 0) sent++;
            }
            if (sent == 0) throw new InvalidOperationException(connect ? "This device can't be connected from the PC. Turn it on to connect it." : "This device can't be disconnected from the PC.");
            return sent;
        }
    }

    static class BtScan
    {
        static readonly object Gate = new object();
        static DeviceWatcher watcher;
        static readonly Dictionary<string, Dictionary<string, object>> Found = new Dictionary<string, Dictionary<string, object>>();
        static DateTime started;

        public static object Start()
        {
            lock (Gate)
            {
                StopLocked();
                Found.Clear();
                started = DateTime.UtcNow;
                var w = DeviceInformation.CreateWatcher(Bluetooth.Aqs(false), Bluetooth.Props, DeviceInformationKind.AssociationEndpoint);
                w.Added += (s, info) =>
                {
                    if (string.IsNullOrWhiteSpace(info.Name)) return;
                    lock (Gate) Found[info.Id] = Bluetooth.Describe(info, null);
                };
                w.Removed += (s, upd) =>
                {
                    lock (Gate) Found.Remove(upd.Id);
                };
                w.Updated += (s, upd) => { };
                w.Start();
                watcher = w;
            }
            return true;
        }

        public static object Results()
        {
            lock (Gate)
            {
                // Scanning is bounded so it never runs forever in the background.
                if (watcher != null && (DateTime.UtcNow - started).TotalSeconds > 90) StopLocked();
                var active = watcher != null && (watcher.Status == DeviceWatcherStatus.Started || watcher.Status == DeviceWatcherStatus.EnumerationCompleted);
                return new Dictionary<string, object>
                {
                    { "scanning", active },
                    { "devices", Found.Values.OrderBy(d => (string)d["name"]).Cast<object>().ToList() },
                };
            }
        }

        public static void Stop()
        {
            lock (Gate) StopLocked();
        }

        static void StopLocked()
        {
            if (watcher == null) return;
            try
            {
                if (watcher.Status == DeviceWatcherStatus.Started || watcher.Status == DeviceWatcherStatus.EnumerationCompleted) watcher.Stop();
            }
            catch { }
            watcher = null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Night Light                                                         */
    /* ------------------------------------------------------------------ */

    // Windows keeps the Night Light switch in a CloudStore blob. Byte 18 is the
    // payload size: 0x15 when the "enabled" field (0x10 0x00) is present.
    static class NightLight
    {
        const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate";

        public static object Get()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(KeyPath))
            {
                var data = k == null ? null : k.GetValue("Data") as byte[];
                return new Dictionary<string, object>
                {
                    { "available", data != null && data.Length > 24 },
                    { "on", data != null && data.Length > 24 && data[18] == 0x15 },
                };
            }
        }

        public static object Set(bool on)
        {
            using (var k = Registry.CurrentUser.OpenSubKey(KeyPath, true))
            {
                if (k == null) throw new InvalidOperationException("Night light is not available on this PC");
                var data = k.GetValue("Data") as byte[];
                if (data == null || data.Length < 25) throw new InvalidOperationException("Night light is not available on this PC");
                var isOn = data[18] == 0x15;
                if (isOn == on) return true;
                var list = data.Take(23).ToList();
                if (on)
                {
                    list.Add(0x10);
                    list.Add(0x00);
                    list.AddRange(data.Skip(23));
                    list[18] = 0x15;
                }
                else
                {
                    list.AddRange(data.Skip(25));
                    list[18] = 0x13;
                }
                // Bump the change timestamp (a varint) so Windows applies it.
                for (var i = 10; i < 15; i++)
                {
                    if ((list[i] & 0x7F) != 0x7F)
                    {
                        list[i]++;
                        break;
                    }
                }
                k.SetValue("Data", list.ToArray(), RegistryValueKind.Binary);
            }
            return true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Controller input (for the in-game overlay)                          */
    /* ------------------------------------------------------------------ */

    // Reads controllers passively, independent of window focus:
    //  * Xbox / XInput pads through XInputGetStateEx (includes the Guide button)
    //  * DualSense / DualShock 4 through their HID input reports
    // The Guide/PS button is always reported. Other buttons are only reported
    // while the overlay is open (Forward = true).
    static class Pad
    {
        const int UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, CONFIRM = 16, BACK = 32, X = 64, Y = 128, OPTIONS = 256, SELECT = 512, L1 = 1024, R1 = 2048, GUIDE = 4096;
        static readonly int[] Bits = { UP, DOWN, LEFT, RIGHT, CONFIRM, BACK, X, Y, OPTIONS, SELECT, L1, R1, GUIDE };
        static readonly string[] Names = { "up", "down", "left", "right", "confirm", "back", "x", "y", "options", "select", "l1", "r1", "guide" };

        public static volatile bool Forward;
        static readonly object Gate = new object();
        static readonly Dictionary<string, int> Prev = new Dictionary<string, int>();
        static readonly Dictionary<string, long> HoldSince = new Dictionary<string, long>();
        static readonly Dictionary<string, long> NextRepeat = new Dictionary<string, long>();
        static readonly Dictionary<string, int> RepeatCount = new Dictionary<string, int>();
        static readonly HashSet<string> HidOpen = new HashSet<string>();
        static readonly List<string> HidSeen = new List<string>();
        static string xinputState = "not loaded";

        static long Now() { return Environment.TickCount; }

        static void Emit(string evt, string action, bool repeat)
        {
            var d = new Dictionary<string, object> { { "event", evt } };
            if (action != null) d["action"] = action;
            if (repeat) d["repeat"] = true;
            Program.Emit(d);
        }

        public static void Update(string src, int mask)
        {
            lock (Gate)
            {
                int prev;
                Prev.TryGetValue(src, out prev);
                Prev[src] = mask;
                var pressed = mask & ~prev;
                for (var i = 0; i < Bits.Length; i++)
                {
                    var bit = Bits[i];
                    var key = src + ":" + bit;
                    if ((pressed & bit) != 0)
                    {
                        if (bit == GUIDE) Emit("guide", null, false);
                        else if (Forward) Emit("pad", Names[i], false);
                        if (bit <= RIGHT)
                        {
                            HoldSince[key] = Now();
                            NextRepeat[key] = Now() + 380;
                            RepeatCount[key] = 0;
                        }
                    }
                    else if ((mask & bit) == 0 && HoldSince.ContainsKey(key))
                    {
                        HoldSince.Remove(key);
                        NextRepeat.Remove(key);
                        RepeatCount.Remove(key);
                    }
                }
            }
        }

        static void Repeats()
        {
            if (!Forward) return;
            lock (Gate)
            {
                var now = Now();
                foreach (var key in NextRepeat.Keys.ToList())
                {
                    if (now < NextRepeat[key]) continue;
                    var n = ++RepeatCount[key];
                    NextRepeat[key] = now + (n > 6 ? 65 : n > 2 ? 90 : 120);
                    var bit = int.Parse(key.Substring(key.LastIndexOf(':') + 1));
                    Emit("pad", Names[Array.IndexOf(Bits, bit)], true);
                }
            }
        }

        public static void Start()
        {
            new Thread(XInputLoop) { IsBackground = true, Name = "xinput" }.Start();
            new Thread(HidScanLoop) { IsBackground = true, Name = "hidscan" }.Start();
        }

        /// <summary>True when no button on any controller is held.</summary>
        public static bool Idle()
        {
            lock (Gate)
            {
                foreach (var m in Prev.Values) if (m != 0) return false;
                return true;
            }
        }

        /// <summary>
        /// Wait (up to timeoutMs) until every button is released. Pausing or
        /// resuming a game mid-press would leave it with a stuck button, e.g.
        /// Eden would see Home held + B pressed = its "toggle fullscreen" shortcut.
        /// </summary>
        public static void WaitIdle(int timeoutMs)
        {
            var end = Now() + timeoutMs;
            while (!Idle() && Now() < end) Thread.Sleep(15);
            // Let the game read one more "everything released" report.
            Thread.Sleep(40);
        }

        public static object Info()
        {
            lock (Gate)
            {
                return new Dictionary<string, object> { { "xinput", xinputState }, { "hidOpen", HidOpen.ToList() }, { "hidSeen", HidSeen.ToList() }, { "forward", Forward } };
            }
        }

        /* ---------------- XInput ---------------- */

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_GAMEPAD { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_STATE { public uint dwPacketNumber; public XINPUT_GAMEPAD Gamepad; }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate uint XInputGetStateFn(uint user, out XINPUT_STATE state);

        [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string name);
        [DllImport("kernel32", EntryPoint = "GetProcAddress")] static extern IntPtr GetProcAddressOrdinal(IntPtr h, IntPtr ordinal);
        [DllImport("kernel32", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr h, string name);

        static void XInputLoop()
        {
            XInputGetStateFn get = null;
            try
            {
                var lib = LoadLibrary("xinput1_4.dll");
                if (lib == IntPtr.Zero) lib = LoadLibrary("xinput1_3.dll");
                if (lib != IntPtr.Zero)
                {
                    var p = GetProcAddressOrdinal(lib, (IntPtr)100); // XInputGetStateEx: includes Guide
                    xinputState = "guide";
                    if (p == IntPtr.Zero)
                    {
                        p = GetProcAddress(lib, "XInputGetState");
                        xinputState = "no guide";
                    }
                    if (p != IntPtr.Zero) get = (XInputGetStateFn)Marshal.GetDelegateForFunctionPointer(p, typeof(XInputGetStateFn));
                }
            }
            catch { }
            if (get == null) xinputState = "unavailable";
            var connected = new bool[4];
            var lastProbe = new long[4];
            while (true)
            {
                if (get != null)
                {
                    for (uint i = 0; i < 4; i++)
                    {
                        // Probing empty slots is slow, so only do it every 2 seconds.
                        if (!connected[i] && Now() - lastProbe[i] < 2000) continue;
                        XINPUT_STATE st;
                        var r = get(i, out st);
                        if (r != 0)
                        {
                            if (connected[i]) Update("x" + i, 0);
                            connected[i] = false;
                            lastProbe[i] = Now();
                            continue;
                        }
                        connected[i] = true;
                        var b = st.Gamepad.wButtons;
                        var m = 0;
                        if ((b & 0x0001) != 0 || st.Gamepad.sThumbLY > 16000) m |= UP;
                        if ((b & 0x0002) != 0 || st.Gamepad.sThumbLY < -16000) m |= DOWN;
                        if ((b & 0x0004) != 0 || st.Gamepad.sThumbLX < -16000) m |= LEFT;
                        if ((b & 0x0008) != 0 || st.Gamepad.sThumbLX > 16000) m |= RIGHT;
                        if ((b & 0x0010) != 0) m |= OPTIONS;
                        if ((b & 0x0020) != 0) m |= SELECT;
                        if ((b & 0x0100) != 0) m |= L1;
                        if ((b & 0x0200) != 0) m |= R1;
                        if ((b & 0x0400) != 0) m |= GUIDE;
                        if ((b & 0x1000) != 0) m |= CONFIRM;
                        if ((b & 0x2000) != 0) m |= BACK;
                        if ((b & 0x4000) != 0) m |= X;
                        if ((b & 0x8000) != 0) m |= Y;
                        Update("x" + i, m);
                    }
                }
                Repeats();
                Thread.Sleep(16);
            }
        }

        /* ---------------- HID (PlayStation controllers) ---------------- */

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }

        [StructLayout(LayoutKind.Sequential)]
        struct HIDP_CAPS
        {
            public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices, NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices, NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
        }

        [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
        [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(Microsoft.Win32.SafeHandles.SafeFileHandle h, out IntPtr data);
        [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr data);
        [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr data, out HIDP_CAPS caps);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr enumerator, IntPtr hwnd, uint flags);
        [DllImport("setupapi.dll")] static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr devInfo, ref Guid g, int index, ref SP_DEVICE_INTERFACE_DATA data);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int size, out int required, IntPtr devInfo);
        [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32", SetLastError = true)] static extern bool ReadFile(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len, out int read, IntPtr overlapped);

        static readonly System.Text.RegularExpressions.Regex PsPad = new System.Text.RegularExpressions.Regex(
            "vid[_&](?:0002)?054c[_&]pid[_&](0ce6|0df2|05c4|09cc|0ba0)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        static List<string> HidPaths()
        {
            var list = new List<string>();
            Guid g;
            HidD_GetHidGuid(out g);
            var set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x2 | 0x10);
            if (set == IntPtr.Zero || set == new IntPtr(-1)) return list;
            try
            {
                for (var i = 0; ; i++)
                {
                    var data = new SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA)) };
                    if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref data)) break;
                    int need;
                    SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out need, IntPtr.Zero);
                    if (need <= 0) continue;
                    var buf = Marshal.AllocHGlobal(need);
                    try
                    {
                        Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
                        if (SetupDiGetDeviceInterfaceDetail(set, ref data, buf, need, out need, IntPtr.Zero))
                            list.Add(Marshal.PtrToStringUni(buf + 4));
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buf);
                    }
                }
            }
            finally
            {
                SetupDiDestroyDeviceInfoList(set);
            }
            return list;
        }

        static void HidScanLoop()
        {
            while (true)
            {
                try
                {
                    foreach (var path in HidPaths())
                    {
                        var m = PsPad.Match(path);
                        if (!m.Success) continue;
                        lock (Gate)
                        {
                            if (!HidSeen.Contains(path)) HidSeen.Add(path);
                            if (HidOpen.Contains(path)) continue;
                            HidOpen.Add(path);
                        }
                        var pid = m.Groups[1].Value.ToLowerInvariant();
                        var p = path;
                        new Thread(() => HidReader(p, pid)) { IsBackground = true, Name = "hid" }.Start();
                    }
                }
                catch { }
                Thread.Sleep(3000);
            }
        }

        static void HidReader(string path, string pid)
        {
            var src = "h" + path.GetHashCode();
            try
            {
                using (var h = CreateFile(path, 0x80000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) return;
                    int len = 128;
                    IntPtr pre;
                    if (HidD_GetPreparsedData(h, out pre))
                    {
                        HIDP_CAPS caps;
                        if (HidP_GetCaps(pre, out caps) == 0x00110000 && caps.InputReportByteLength > 0) len = caps.InputReportByteLength;
                        HidD_FreePreparsedData(pre);
                    }
                    var buf = new byte[Math.Max(len, 16)];
                    while (true)
                    {
                        int read;
                        if (!ReadFile(h, buf, len, out read, IntPtr.Zero) || read <= 0) break;
                        var mask = ParsePs(buf, read, pid);
                        if (mask >= 0) Update(src, mask);
                    }
                }
            }
            catch { }
            finally
            {
                Update(src, 0);
                lock (Gate) HidOpen.Remove(path);
            }
        }

        static int ParsePs(byte[] b, int n, string pid)
        {
            var dualsense = pid == "0ce6" || pid == "0df2";
            int lx, ly, b0, b1, b2;
            if (dualsense)
            {
                if (b[0] == 0x01 && n >= 64) { lx = 1; ly = 2; b0 = 8; b1 = 9; b2 = 10; }        // USB
                else if (b[0] == 0x31 && n >= 12) { lx = 2; ly = 3; b0 = 9; b1 = 10; b2 = 11; }  // Bluetooth (full report)
                else if (b[0] == 0x01 && n >= 8) { lx = 1; ly = 2; b0 = 5; b1 = 6; b2 = 7; }     // Bluetooth (simple report)
                else return -1;
            }
            else
            {
                if (b[0] == 0x01 && n >= 8) { lx = 1; ly = 2; b0 = 5; b1 = 6; b2 = 7; }          // DS4 USB / simple BT
                else if (b[0] == 0x11 && n >= 10) { lx = 3; ly = 4; b0 = 7; b1 = 8; b2 = 9; }    // DS4 Bluetooth
                else return -1;
            }
            var m = 0;
            var hat = b[b0] & 0x0F;
            if (hat == 7 || hat == 0 || hat == 1 || b[ly] < 50) m |= UP;
            if (hat == 3 || hat == 4 || hat == 5 || b[ly] > 205) m |= DOWN;
            if (hat == 5 || hat == 6 || hat == 7 || b[lx] < 50) m |= LEFT;
            if (hat == 1 || hat == 2 || hat == 3 || b[lx] > 205) m |= RIGHT;
            if ((b[b0] & 0x10) != 0) m |= X;        // square
            if ((b[b0] & 0x20) != 0) m |= CONFIRM;  // cross
            if ((b[b0] & 0x40) != 0) m |= BACK;     // circle
            if ((b[b0] & 0x80) != 0) m |= Y;        // triangle
            if ((b[b1] & 0x01) != 0) m |= L1;
            if ((b[b1] & 0x02) != 0) m |= R1;
            if ((b[b1] & 0x10) != 0) m |= SELECT;   // create / share
            if ((b[b1] & 0x20) != 0) m |= OPTIONS;
            if ((b[b2] & 0x01) != 0) m |= GUIDE;    // PS button
            return m;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Processes (running-game detection, closing games)                   */
    /* ------------------------------------------------------------------ */

    // Process names come from the system process list and full image paths
    // from NtQuerySystemInformation(SystemProcessIdInformation), so no handle to
    // any (game) process is ever opened.
    static class Procs
    {
        [StructLayout(LayoutKind.Sequential)]
        struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

        [StructLayout(LayoutKind.Sequential)]
        struct SYSTEM_PROCESS_ID_INFORMATION { public IntPtr ProcessId; public UNICODE_STRING ImageName; }

        [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, ref SYSTEM_PROCESS_ID_INFORMATION info, int len, out int retLen);
        [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern uint QueryDosDevice(string device, StringBuilder target, int max);

        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

        static Dictionary<string, string> devices;

        public static object List()
        {
            var list = new List<object>();
            foreach (var p in System.Diagnostics.Process.GetProcesses())
            {
                try { list.Add(new Dictionary<string, object> { { "pid", p.Id }, { "name", p.ProcessName } }); }
                catch { }
                p.Dispose();
            }
            return list;
        }

        static string ToDos(string nt)
        {
            if (devices == null)
            {
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (var c = 'A'; c <= 'Z'; c++)
                {
                    var sb = new StringBuilder(512);
                    if (QueryDosDevice(c + ":", sb, sb.Capacity) > 0) map[sb.ToString()] = c + ":";
                }
                devices = map;
            }
            foreach (var kv in devices)
            {
                if (nt.StartsWith(kv.Key + "\\", StringComparison.OrdinalIgnoreCase)) return kv.Value + nt.Substring(kv.Key.Length);
            }
            return nt;
        }

        public static string ImagePath(int pid)
        {
            var buf = Marshal.AllocHGlobal(4096);
            try
            {
                var info = new SYSTEM_PROCESS_ID_INFORMATION
                {
                    ProcessId = new IntPtr(pid),
                    ImageName = new UNICODE_STRING { Length = 0, MaximumLength = 4096, Buffer = buf },
                };
                int ret;
                if (NtQuerySystemInformation(88, ref info, Marshal.SizeOf(typeof(SYSTEM_PROCESS_ID_INFORMATION)), out ret) != 0) return null;
                return ToDos(Marshal.PtrToStringUni(buf, info.ImageName.Length / 2));
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }

        /// <summary>Ask a process to close by sending WM_CLOSE to its visible windows.</summary>
        public static int CloseWindows(int pid)
        {
            var n = 0;
            EnumWindowsProc cb = (h, l) =>
            {
                uint owner;
                GetWindowThreadProcessId(h, out owner);
                if (owner == pid && IsWindowVisible(h) && PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero)) n++;
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return n;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Foreground window                                                   */
    /* ------------------------------------------------------------------ */

    static class Fg
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        [DllImport("user32")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("kernel32")] static extern uint GetCurrentThreadId();
        [DllImport("user32")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [DllImport("user32")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
        [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

        [StructLayout(LayoutKind.Sequential)]
        struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor, rcWork;
            public uint dwFlags;
        }

        static RECT MonitorRect(IntPtr h)
        {
            var info = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
            var m = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
            if (m != IntPtr.Zero && GetMonitorInfo(m, ref info)) return info.rcMonitor;
            return new RECT { L = 0, T = 0, R = 1920, B = 1080 };
        }

        public static object Get()
        {
            var h = GetForegroundWindow();
            if (h == IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            RECT r;
            GetWindowRect(h, out r);
            var m = MonitorRect(h);
            return new Dictionary<string, object>
            {
                { "hwnd", h.ToInt64() },
                { "pid", (int)pid },
                { "x", r.L }, { "y", r.T }, { "w", r.R - r.L }, { "h", r.B - r.T },
                { "mw", m.R - m.L }, { "mh", m.B - m.T },
                { "name", SafeName((int)pid) },
            };
        }

        static string SafeName(int pid)
        {
            try { return System.IO.Path.GetFileNameWithoutExtension(Procs.ImagePath(pid) ?? ""); } catch { return ""; }
        }

        /// <summary>
        /// Visible top-level windows of every process running from one of the
        /// given folders, with their size and their monitor's size. Process
        /// paths come from the system process list (no process handles).
        /// </summary>
        public static List<object> DirWindows(List<string> dirs)
        {
            var roots = dirs.Where(d => !string.IsNullOrEmpty(d))
                .Select(d => System.IO.Path.GetFullPath(d).TrimEnd('\\').ToLowerInvariant() + "\\").ToList();
            var list = new List<object>();
            if (roots.Count == 0) return list;
            var fg = GetForegroundWindow();
            var paths = new Dictionary<uint, string>();
            EnumWindowsProc cb = (h, l) =>
            {
                if (!IsWindowVisible(h) || GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string path;
                if (!paths.TryGetValue(pid, out path))
                {
                    try { path = (Procs.ImagePath((int)pid) ?? "").ToLowerInvariant(); } catch { path = ""; }
                    paths[pid] = path;
                }
                if (path.Length == 0 || !roots.Any(root => path.StartsWith(root))) return true;
                RECT r;
                GetWindowRect(h, out r);
                var m = MonitorRect(h);
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, sb.Capacity);
                list.Add(new Dictionary<string, object>
                {
                    { "hwnd", h.ToInt64() },
                    { "pid", (int)pid },
                    { "name", System.IO.Path.GetFileNameWithoutExtension(path) },
                    { "title", sb.ToString() },
                    { "w", r.R - r.L }, { "h", r.B - r.T },
                    { "mw", m.R - m.L }, { "mh", m.B - m.T },
                    { "fg", h == fg },
                });
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        /// <summary>Bring a window to the foreground (the usual AttachThreadInput technique).</summary>
        public static bool Set(long hwnd)
        {
            var h = new IntPtr(hwnd);
            if (!IsWindow(h)) return false;
            var fg = GetForegroundWindow();
            if (fg == h) return true;
            uint ignored;
            var fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignored);
            var me = GetCurrentThreadId();
            var attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
            try
            {
                if (IsIconic(h)) ShowWindow(h, 9);
                BringWindowToTop(h);
                SetForegroundWindow(h);
                if (GetForegroundWindow() != h)
                {
                    keybd_event(0xE8, 0, 0, UIntPtr.Zero);
                    keybd_event(0xE8, 0, 2 /* KEYEVENTF_KEYUP */, UIntPtr.Zero);
                    BringWindowToTop(h);
                    SetForegroundWindow(h);
                }
            }
            finally
            {
                if (attached) AttachThreadInput(me, fgThread, false);
            }
            return GetForegroundWindow() == h;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Game windows: titles, focusing, pausing                             */
    /* ------------------------------------------------------------------ */

    static class GameWin
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [DllImport("user32")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32")] static extern IntPtr GetWindow(IntPtr h, uint cmd);

        [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
        [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
        [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);

        static readonly object Gate = new object();
        static readonly HashSet<int> Suspended = new HashSet<int>();

        /// <summary>Visible, un-owned top-level windows of a process (by window manager only — no process handle).</summary>
        static List<IntPtr> Windows(int pid)
        {
            var list = new List<IntPtr>();
            EnumWindowsProc cb = (h, l) =>
            {
                uint owner;
                GetWindowThreadProcessId(h, out owner);
                if (owner == pid && IsWindowVisible(h) && GetWindow(h, 4 /* GW_OWNER */) == IntPtr.Zero) list.Add(h);
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        public static object Titles(int pid)
        {
            var titles = new List<object>();
            foreach (var h in Windows(pid))
            {
                var sb = new StringBuilder(512);
                if (GetWindowText(h, sb, sb.Capacity) > 0) titles.Add(sb.ToString());
            }
            return titles;
        }

        /// <summary>Bring the biggest window of a process to the front.</summary>
        public static bool Focus(int pid)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = -1;
            foreach (var h in Windows(pid))
            {
                RECT r;
                GetWindowRect(h, out r);
                long area = (long)(r.R - r.L) * (r.B - r.T);
                if (area > bestArea)
                {
                    bestArea = area;
                    best = h;
                }
            }
            return best != IntPtr.Zero && Fg.Set(best.ToInt64());
        }

        /// <summary>
        /// Pause / resume a game while the menu is open. Only used for games without
        /// anti-cheat (the launcher checks the game folder first).
        /// </summary>
        public static bool Suspend(int pid, bool suspend)
        {
            lock (Gate)
            {
                if (suspend == Suspended.Contains(pid)) return true;
                var h = OpenProcess(0x0800 /* PROCESS_SUSPEND_RESUME */, false, pid);
                if (h == IntPtr.Zero) return false;
                try
                {
                    var st = suspend ? NtSuspendProcess(h) : NtResumeProcess(h);
                    if (st != 0) return false;
                    if (suspend) Suspended.Add(pid);
                    else Suspended.Remove(pid);
                    return true;
                }
                finally
                {
                    CloseHandle(h);
                }
            }
        }

        /// <summary>Never leave a game frozen: resume everything when the launcher goes away.</summary>
        public static void ResumeAll()
        {
            lock (Gate)
            {
                foreach (var pid in Suspended.ToList())
                {
                    var h = OpenProcess(0x0800, false, pid);
                    if (h == IntPtr.Zero) continue;
                    NtResumeProcess(h);
                    CloseHandle(h);
                }
                Suspended.Clear();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Network: is a game online right now?                               */
    /* ------------------------------------------------------------------ */

    // Reads the system TCP table (no handle to the game). Used to avoid pausing
    // games that are connected to a server, which would disconnect them.
    static class Net
    {
        [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sort, int af, int tableClass, int reserved);

        public static int Established(int pid)
        {
            return Count(pid, 2) + Count(pid, 23);
        }

        static int Count(int pid, int af)
        {
            int size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 4 /* TCP_TABLE_OWNER_PID_CONNECTIONS */, 0);
            if (size <= 0) return 0;
            var buf = Marshal.AllocHGlobal(size);
            try
            {
                if (GetExtendedTcpTable(buf, ref size, false, af, 4, 0) != 0) return 0;
                int rows = Marshal.ReadInt32(buf);
                int n = 0;
                if (af == 2)
                {
                    // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid (6 x 4 bytes)
                    for (int i = 0; i < rows; i++)
                    {
                        var row = buf + 4 + i * 24;
                        int state = Marshal.ReadInt32(row);
                        uint remote = (uint)Marshal.ReadInt32(row + 12);
                        int owner = Marshal.ReadInt32(row + 20);
                        if (owner == pid && state == 5 && (remote & 0xFF) != 127) n++;
                    }
                }
                else
                {
                    // MIB_TCP6ROW_OWNER_PID: localAddr[16], localScope, localPort, remoteAddr[16], remoteScope, remotePort, state, pid
                    for (int i = 0; i < rows; i++)
                    {
                        var row = buf + 4 + i * 56;
                        int state = Marshal.ReadInt32(row + 48);
                        int owner = Marshal.ReadInt32(row + 52);
                        bool loopback = true;
                        for (int b = 0; b < 15; b++) if (Marshal.ReadByte(row + 24 + b) != 0) { loopback = false; break; }
                        if (Marshal.ReadByte(row + 24 + 15) != 1) loopback = false;
                        if (owner == pid && state == 5 && !loopback) n++;
                    }
                }
                return n;
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }
    }
}
