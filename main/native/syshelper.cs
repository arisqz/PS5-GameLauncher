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
            AppDomain.CurrentDomain.ProcessExit += (s, e) => { GameWin.ResumeAll(); Passthrough.ShutDown(); };
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
            Passthrough.ShutDown();
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
                case "mediaPlaying": return Media.AnyPlaying();
                case "mediaCmd": return Media.Command(Str(req, "app"), Str(req, "action"), Int(req, "value", 0));
                case "volume": return new Dictionary<string, object> { { "volume", Audio.GetVolume() }, { "muted", Audio.GetMute() } };
                case "setVolume": Audio.SetVolume(Int(req, "value", 50)); return true;
                case "setMute": Audio.SetMute(Bool(req, "value")); return true;
                case "audioOutputs": return Audio.Outputs();
                case "setAudioOutput": return Audio.SetOutput(Str(req, "device"));
                case "brightness": return Monitors.Get();
                case "setBrightness": return Monitors.Set(Int(req, "value", 50), Int(req, "index", -1));
                case "nightLight": return NightLight.Get();
                case "hdr": return Hdr.Get();
                case "setHdr": return Hdr.Set(Bool(req, "value"), Int(req, "index", -1));
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
                case "passthroughRate": return Passthrough.SetRate(Int(req, "usb", 0), Int(req, "bt", 0));
                case "passthrough":
                    if (req.ContainsKey("rateUsb")) Passthrough.SetRate(Int(req, "rateUsb", 0), Int(req, "rateBt", 0));
                    if (req.ContainsKey("mode")) Passthrough.Configure(Str(req, "mode"));
                    return Passthrough.Enable(Bool(req, "value"));
                case "passthroughConfig": return Passthrough.Configure(Str(req, "mode"));
                case "passthroughMute": return Passthrough.SetMuted(Bool(req, "value"));
                case "passthroughStatus": return Passthrough.Status();
                case "dualsenseInfo": return PadInfo.List(Bool(req, "refresh"));
                case "gamepads": return Pad.Gamepads();
                case "drives":
                    // Local drives (Settings › Storage): letter, label, size and free space.
                    return DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady).Select(d => new Dictionary<string, object>
                    {
                        { "root", d.RootDirectory.FullName },
                        { "label", d.VolumeLabel },
                        { "total", d.TotalSize },
                        { "free", d.AvailableFreeSpace },
                    }).ToArray();
                case "captureButton": Passthrough.StripCreate = Bool(req, "value"); return true;
                case "launch": return Launch(Str(req, "file"), Str(req, "args"), Str(req, "cwd"));
                case "windowTitles": return GameWin.Titles(Int(req, "pid", 0));
                case "focusProc": return GameWin.Focus(Int(req, "pid", 0));
                case "suspend": if (Bool(req, "wait")) Pad.WaitIdle(1500); return GameWin.Suspend(Int(req, "pid", 0), true);
                case "resume": if (Bool(req, "wait")) Pad.WaitIdle(1500); return GameWin.Suspend(Int(req, "pid", 0), false);
                case "resumeAll": GameWin.ResumeAll(); return true;
                case "netConns": return Net.Established(Int(req, "pid", 0));
                case "procIo": return Procs.Io(Str(req, "name"));
                case "appWindows": return Procs.Windows(Str(req, "name"), Str(req, "title"));
                case "windowCmd": return Procs.WindowCmd(Long(req, "hwnd"), Str(req, "action"));
                case "procQos":
                    var pids = req.ContainsKey("pids") && req["pids"] is System.Collections.ArrayList ? ((System.Collections.ArrayList)req["pids"]).Cast<object>().Select(o => Convert.ToInt32(o)) : Enumerable.Empty<int>();
                    return Qos.Apply(pids, Bool(req, "eco"), Bool(req, "lower"), Bool(req, "trim"));
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

        /// <summary>Is another app playing media right now? (The launcher pauses its menu music meanwhile.)</summary>
        public static bool AnyPlaying()
        {
            try
            {
                foreach (var s in Manager().GetSessions())
                {
                    var id = s.SourceAppUserModelId ?? "";
                    if (id.IndexOf("electron", StringComparison.OrdinalIgnoreCase) >= 0 || id.IndexOf("PS5 Game Launcher", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                    if (IsPlaying(s)) return true;
                }
            }
            catch { }
            return false;
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
    /// <summary>
    /// HDR per display, as Windows' own "Use HDR" switch (Settings > Display) sets
    /// it. Windows 11 24H2 and later have their own HDR state (advanced color can
    /// also be just wide color there); older ones only have advanced color.
    /// </summary>
    static class Hdr
    {
        [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
        [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArray, ref uint modes, IntPtr modeArray, IntPtr topology);
        [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr packet);
        [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr packet);

        const int GET_TARGET_NAME = 2, GET_ADVANCED_COLOR_INFO = 9, SET_ADVANCED_COLOR_STATE = 10, GET_ADVANCED_COLOR_INFO_2 = 15, SET_HDR_STATE = 16;

        class Target { public long Luid; public uint Id; public string Name; public bool Supported, On, Newer; }

        static void Fill(IntPtr packet, int type, int size, long luid, uint id)
        {
            for (int i = 0; i < size; i += 4) Marshal.WriteInt32(packet, i, 0);
            Marshal.WriteInt32(packet, 0, type);
            Marshal.WriteInt32(packet, 4, size);
            Marshal.WriteInt64(packet, 8, luid);
            Marshal.WriteInt32(packet, 16, (int)id);
        }

        static List<Target> Targets()
        {
            var list = new List<Target>();
            const int PathSize = 72, ModeSize = 64;
            uint np, nm;
            if (GetDisplayConfigBufferSizes(2 /* QDC_ONLY_ACTIVE_PATHS */, out np, out nm) != 0 || np == 0) return list;
            IntPtr paths = Marshal.AllocHGlobal((int)np * PathSize), modes = Marshal.AllocHGlobal((int)nm * ModeSize), pkt = Marshal.AllocHGlobal(420);
            try
            {
                if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return list;
                for (int i = 0; i < np; i++)
                {
                    IntPtr p = paths + i * PathSize;
                    // The target (monitor): adapter LUID at +20, id at +28.
                    var t = new Target { Luid = Marshal.ReadInt64(p, 20), Id = (uint)Marshal.ReadInt32(p, 28) };
                    Fill(pkt, GET_TARGET_NAME, 420, t.Luid, t.Id);
                    if (DisplayConfigGetDeviceInfo(pkt) == 0) t.Name = Marshal.PtrToStringUni(pkt + 36);
                    Fill(pkt, GET_ADVANCED_COLOR_INFO_2, 36, t.Luid, t.Id);
                    if (DisplayConfigGetDeviceInfo(pkt) == 0)
                    {
                        var v = Marshal.ReadInt32(pkt, 20);
                        t.Newer = true;
                        t.Supported = (v & 0x10) != 0; // highDynamicRangeSupported
                        t.On = (v & 0x20) != 0;        // highDynamicRangeUserEnabled
                    }
                    else
                    {
                        Fill(pkt, GET_ADVANCED_COLOR_INFO, 32, t.Luid, t.Id);
                        if (DisplayConfigGetDeviceInfo(pkt) != 0) continue;
                        var v = Marshal.ReadInt32(pkt, 20);
                        t.Supported = (v & 0x1) != 0 && (v & 0x8) == 0; // supported, not forced off
                        t.On = (v & 0x2) != 0;
                    }
                    list.Add(t);
                }
            }
            catch { }
            finally
            {
                Marshal.FreeHGlobal(paths);
                Marshal.FreeHGlobal(modes);
                Marshal.FreeHGlobal(pkt);
            }
            return list;
        }

        public static object Get()
        {
            return Targets().Select(t => new Dictionary<string, object> { { "name", t.Name ?? "" }, { "supported", t.Supported }, { "on", t.On } }).ToList();
        }

        /// <summary>HDR on or off: one display (index into Get()), or every one that has it (-1). Returns how many were set.</summary>
        public static int Set(bool on, int index)
        {
            var all = Targets();
            int n = 0;
            IntPtr pkt = Marshal.AllocHGlobal(24);
            try
            {
                for (int i = 0; i < all.Count; i++)
                {
                    var t = all[i];
                    if ((index >= 0 && i != index) || !t.Supported || t.On == on) continue;
                    Fill(pkt, t.Newer ? SET_HDR_STATE : SET_ADVANCED_COLOR_STATE, 24, t.Luid, t.Id);
                    Marshal.WriteInt32(pkt, 20, on ? 1 : 0);
                    if (DisplayConfigSetDeviceInfo(pkt) == 0) n++;
                }
            }
            finally { Marshal.FreeHGlobal(pkt); }
            return n;
        }
    }

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
    /* ------------------------------------------------------------------ */
    /* Controller passthrough (HidHide + VIIPER)                           */
    /* ------------------------------------------------------------------ */

    /// <summary>
    /// Games never see the real PlayStation controller: HidHide hides it from
    /// every program except this helper, and a virtual DualSense made by VIIPER
    /// (usbip-win2) takes its place. The helper forwards the real controller's
    /// input to the virtual one and the game's rumble / lightbar back. While a
    /// menu is open the virtual controller gets a "nothing pressed" state, so
    /// the game can't react to the menu's button presses.
    /// HidHide's session list is cleared by Windows when this process exits.
    /// </summary>
    static class Passthrough
    {
        public static volatile bool Enabled;
        public static volatile bool Muted;
        /// <summary>Keep the Create button from games (it opens the launcher's capture menu).</summary>
        public static volatile bool StripCreate;
        static readonly object Gate = new object();
        /// <summary>
        /// Held while virtual pads are made or removed (and the USB bus with them):
        /// libVIIPER aborts the whole process (a "STATUS_WAIT_2" box) on a fatal
        /// error, so a device is never removed while it is still being made, or
        /// after its bus is gone. Taken before Gate, never inside it.
        /// </summary>
        static readonly object Change = new object();
        static volatile bool shuttingDown;
        static readonly Dictionary<string, Virtual> Pads = new Dictionary<string, Virtual>();
        static readonly HashSet<string> Hidden = new HashSet<string>();
        static string hidhide = "unknown"; // ok | missing | denied | error
        static string viiper = "unknown"; // ok | missing | error
        static string lastError = null;
        static bool restoreInactive;
        static bool inverse;
        static List<string> allowed = new List<string>(); // other programs HidHide lets see hidden controllers
        static int busId = -1;

        /* ---------------- HidHide ---------------- */

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32", SetLastError = true)]
        static extern bool DeviceIoControl(Microsoft.Win32.SafeHandles.SafeFileHandle h, uint code, byte[] inBuf, int inLen, byte[] outBuf, int outLen, out int returned, IntPtr overlapped);
        [DllImport("kernel32", CharSet = CharSet.Unicode)]
        static extern uint QueryDosDevice(string device, StringBuilder target, int max);

        static uint Ioctl(int fn) { return (32769u << 16) | (1u << 14) | ((uint)fn << 2); }
        const int GET_WHITELIST = 2048, SET_WHITELIST = 2049, GET_BLACKLIST = 2050, SET_BLACKLIST = 2051, GET_ACTIVE = 2052, SET_ACTIVE = 2053, GET_WLINVERSE = 2054, ADD_SESSION = 2056, CLR_SESSION = 2057;
        static Microsoft.Win32.SafeHandles.SafeFileHandle control;

        static bool OpenHidHide()
        {
            if (control != null && !control.IsInvalid) return true;
            control = CreateFile("\\\\.\\HidHide", 0x80000000, 0x1 | 0x2 | 0x4, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (!control.IsInvalid) return true;
            var err = Marshal.GetLastWin32Error();
            hidhide = err == 5 ? "denied" : err == 2 ? "missing" : "error";
            control = null;
            return false;
        }

/// <summary>Send a request; input may be null (requests without data).</summary>
        static void Put(int fn, byte[] input)
        {
            int got;
            if (!DeviceIoControl(control, Ioctl(fn), input, input == null ? 0 : input.Length, null, 0, out got, IntPtr.Zero)) throw Fail(fn);
        }

        /// <summary>An on/off value: HidHide wants a buffer of exactly one byte.</summary>
        static bool GetFlag(int fn)
        {
            int got;
            var b = new byte[1];
            if (!DeviceIoControl(control, Ioctl(fn), null, 0, b, 1, out got, IntPtr.Zero)) throw Fail(fn);
            return b[0] != 0;
        }

        /// <summary>A string list: ask for the size first, then read it.</summary>
        static byte[] GetList(int fn)
        {
            int got;
            if (!DeviceIoControl(control, Ioctl(fn), null, 0, null, 0, out got, IntPtr.Zero)) throw Fail(fn);
            if (got <= 0) return new byte[0];
            var buf = new byte[got];
            if (!DeviceIoControl(control, Ioctl(fn), null, 0, buf, buf.Length, out got, IntPtr.Zero)) throw Fail(fn);
            return buf.Take(got).ToArray();
        }

        static Exception Fail(int fn)
        {
            var e = new System.ComponentModel.Win32Exception();
            return new System.ComponentModel.Win32Exception(e.NativeErrorCode, "HidHide " + fn + ": " + e.Message);
        }

        static List<string> FromMulti(byte[] b)
        {
            if (b == null || b.Length < 2) return new List<string>();
            return Encoding.Unicode.GetString(b).Split('\0').Where(s => s.Length > 0).ToList();
        }

        static byte[] ToMulti(IEnumerable<string> list)
        {
            return Encoding.Unicode.GetBytes(string.Join("\0", list) + "\0\0");
        }

        /// <summary>"C:\x\y.exe" -> "\Device\HarddiskVolume3\x\y.exe", the form HidHide keeps.</summary>
        static string FullImageName(string path)
        {
            var sb = new StringBuilder(1024);
            if (path.Length < 2 || QueryDosDevice(path.Substring(0, 2), sb, sb.Capacity) == 0) return null;
            return sb.ToString() + path.Substring(2);
        }

        static bool SetupHidHide()
        {
            if (!OpenHidHide()) return false;
            try
            {
                inverse = GetFlag(GET_WLINVERSE);
                var me = FullImageName(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
                var wl = FromMulti(GetList(GET_WHITELIST));
                // Anything else on the list (Steam, for example) still reads the real controller.
                allowed = wl.Where(x => !string.Equals(x, me, StringComparison.OrdinalIgnoreCase) && !x.EndsWith("\\syshelper.exe", StringComparison.OrdinalIgnoreCase))
                    .Select(x => x.Substring(x.LastIndexOf('\\') + 1)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                if (me != null && !inverse)
                {
                    if (!wl.Any(x => string.Equals(x, me, StringComparison.OrdinalIgnoreCase)))
                    {
                        wl.Add(me);
                        Put(SET_WHITELIST, ToMulti(wl));
                    }
                }
                if (!GetFlag(GET_ACTIVE))
                {
                    Put(SET_ACTIVE, new byte[] { 1 });
                    restoreInactive = true;
                }
                hidhide = "ok";
                return true;
            }
            catch (Exception e)
            {
                hidhide = e is System.ComponentModel.Win32Exception && ((System.ComponentModel.Win32Exception)e).NativeErrorCode == 5 ? "denied" : "error";
                lastError = e.Message;
                return false;
            }
        }

        static void Hide(string devicePath)
        {
            if (hidhide != "ok") return;
            var inst = Pad.InstancePath(devicePath);
            lock (Gate)
            {
                if (!Hidden.Add(inst)) return;
            }
            // HidHide releases up to 1.5 don't have the session list (2056); use the
            // normal device list there and remember what we added, so it can be undone.
            if (!sessionUnsupported)
            {
                try { Put(ADD_SESSION, ToMulti(new[] { inst })); }
                catch { sessionUnsupported = true; }
            }
            if (sessionUnsupported)
            {
                try { AddToBlacklist(inst); } catch (Exception e) { lastError = e.Message; return; }
            }
            // Hiding only stops new opens: games (and Steam) that already have the
            // controller keep reading it. Restarting the device closes those handles,
            // like a replug, so from then on they only find the virtual one.
            new Thread(() => { Thread.Sleep(100); RestartDevice(inst); }) { IsBackground = true, Name = "pad-restart" }.Start();
        }

        static bool sessionUnsupported;

        /// <summary>Devices we put on HidHide's (permanent) list, so a crash can't leave them hidden.</summary>
        static string RecordFile
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PS5 Game Launcher", "hidhide-hidden.txt"); }
        }

        static List<string> Recorded()
        {
            try { return File.Exists(RecordFile) ? File.ReadAllLines(RecordFile).Where(l => l.Length > 0).ToList() : new List<string>(); }
            catch { return new List<string>(); }
        }

        static void AddToBlacklist(string inst)
        {
            var bl = FromMulti(GetList(GET_BLACKLIST));
            if (bl.Any(x => string.Equals(x, inst, StringComparison.OrdinalIgnoreCase))) return; // already hidden by the user: leave it to them
            var rec = Recorded();
            if (!rec.Contains(inst))
            {
                rec.Add(inst);
                Directory.CreateDirectory(Path.GetDirectoryName(RecordFile));
                File.WriteAllLines(RecordFile, rec);
            }
            bl.Add(inst);
            Put(SET_BLACKLIST, ToMulti(bl));
        }

        /// <summary>Take back what we added (also the leftovers of a run that crashed).</summary>
        public static void RemoveRecorded()
        {
            var rec = Recorded();
            if (rec.Count == 0 || !OpenHidHide()) return;
            try
            {
                var bl = FromMulti(GetList(GET_BLACKLIST));
                var left = bl.Where(x => !rec.Any(r => string.Equals(r, x, StringComparison.OrdinalIgnoreCase))).ToList();
                if (left.Count != bl.Count) Put(SET_BLACKLIST, ToMulti(left));
                File.Delete(RecordFile);
            }
            catch (Exception e) { lastError = e.Message; }
        }

        /// <summary>Restart a device (not persistent, like replugging it). Needs admin, as HidHide does.</summary>
        static void RestartDevice(string instance)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "pnputil.exe"), "/restart-device \"" + instance + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                Pad.ScanFast(6000);
                using (var p = System.Diagnostics.Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(15000);
                    Pad.ScanFast(6000);
                    if (p.ExitCode != 0 && p.ExitCode != 3010) lastError = "Couldn't restart the controller (" + output.Trim() + "). Reconnect it once.";
                }
            }
            catch (Exception e) { lastError = "Couldn't restart the controller: " + e.Message + ". Reconnect it once."; }
        }

        static void UnhideAll()
        {
            List<string> was;
            lock (Gate)
            {
                was = Hidden.ToList();
                Hidden.Clear();
                XboxHidden.Clear();
            }
            if (control == null) return;
            if (!sessionUnsupported) try { Put(CLR_SESSION, null); } catch { }
            RemoveRecorded();
            // Reconnect them so games pick the real controller up again right away.
            foreach (var inst in was)
            {
                var i = inst;
                new Thread(() => RestartDevice(i)) { IsBackground = true, Name = "pad-restart" }.Start();
            }
            if (restoreInactive)
            {
                try { Put(SET_ACTIVE, new byte[] { 0 }); } catch { }
                restoreInactive = false;
            }
        }

        /* ---------------- VIIPER (libVIIPER) ---------------- */

        /*
         * The virtual controllers come from libVIIPER, the VIIPER fork DualSense
         * Client embeds (github.com/DualSenseClient/VIIPER, GPL-3.0). libVIIPER.dll
         * sits next to this helper (scripts/fetch-libviiper.js) and runs its own
         * USB/IP server in here, on its own port so a standalone VIIPER can keep
         * running; the devices attach through usbip-win2. As in DualSense Client,
         * what a game sends a virtual DualSense (rumble, adaptive triggers, lights,
         * and the HD haptics it plays on its audio interface) goes on to the real
         * pad. Its input is the real pad's state (sticks, buttons, triggers, touch,
         * motion, battery) rather than the raw report DualSense Client prefers: with
         * a raw report set, libVIIPER answers the host's every poll at once, and
         * that loop cost ~7% of the CPU (measured 2026-10-18; ~0.4% this way).
         */
        static class Lib
        {
            const string Dll = "libVIIPER.dll";
            /// <summary>
            /// Loopback only; a standalone VIIPER keeps the default 3241. libVIIPER
            /// has usbip-win2 connect to "localhost", which Windows tries as ::1
            /// first: with the server on 127.0.0.1 only, that refused attempt cost
            /// 2 s on every virtual controller (Windows retries a refused connect).
            /// </summary>
            public static readonly string[] Addrs = { "[::1]:3245", "127.0.0.1:3245" };

            [StructLayout(LayoutKind.Sequential)]
            public struct ServerConfig
            {
                [MarshalAs(UnmanagedType.LPStr)] public string Addr;
                public ulong ConnectionTimeoutMs;
                public ulong DeviceConnectTimeoutMs;
                public uint FlushIntervalMs;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct DsState
            {
                public sbyte LX, LY, RX, RY;
                public uint Buttons;
                public byte DPad, L2, R2;
                public ushort Touch1X, Touch1Y;
                public byte Touch1Active, Touch1Tracking;
                public ushort Touch2X, Touch2Y;
                public byte Touch2Active, Touch2Tracking;
                public short GyroX, GyroY, GyroZ, AccelX, AccelY, AccelZ;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct DsMeta
            {
                [MarshalAs(UnmanagedType.LPStr)] public string SerialNumber, MACAddress, Board;
                public byte BatteryStatus;
                public double TemperatureCelsius, BatteryVoltage;
                [MarshalAs(UnmanagedType.LPStr)] public string ShellColor;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct Ds4State
            {
                public sbyte LX, LY, RX, RY;
                public ushort Buttons;
                public byte DPad, L2, R2;
                public ushort Touch1X, Touch1Y;
                public byte Touch1Active;
                public ushort Touch2X, Touch2Y;
                public byte Touch2Active;
                public short GyroX, GyroY, GyroZ, AccelX, AccelY, AccelZ;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct X360State
            {
                public uint Buttons;
                public byte LT, RT;
                public short LX, LY, RX, RY;
                public byte R0, R1, R2, R3, R4, R5;
            }

            [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void LogCallback(int level, IntPtr message);
            [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OutputCallback(UIntPtr dev, IntPtr state);
            [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void PcmCallback(UIntPtr dev, IntPtr pcm, UIntPtr length);
            [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void ResetCallback(UIntPtr dev);
            [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void Ds4OutputCallback(UIntPtr dev, byte flags, byte small, byte large, byte r, byte g, byte b, byte flashOn, byte flashOff);
            [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void RumbleCallback(UIntPtr dev, byte left, byte right);

            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool NewUSBServer(ref ServerConfig config, out UIntPtr server, LogCallback log);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool CreateUSBBus(UIntPtr server, ref uint bus);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool RemoveUSBBus(UIntPtr server, uint bus);

            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool CreateDualSenseDevice(UIntPtr server, out UIntPtr dev, uint bus, [MarshalAs(UnmanagedType.I1)] bool attach, ushort vid, ushort pid, IntPtr meta);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool CreateDualSenseEdgeDevice(UIntPtr server, out UIntPtr dev, uint bus, [MarshalAs(UnmanagedType.I1)] bool attach, ushort vid, ushort pid, IntPtr meta);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseRawInputReport(UIntPtr dev, byte[] data, UIntPtr length);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseDeviceState(UIntPtr dev, DsState state);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseMetaState(UIntPtr dev, ref DsMeta meta);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseOutputCallback(UIntPtr dev, OutputCallback cb);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseRealtimeHapticsCallback(UIntPtr dev, PcmCallback cb);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseAudioOutCallback(UIntPtr dev, PcmCallback cb);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDualSenseSpeakerResetCallback(UIntPtr dev, ResetCallback cb);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool RemoveDualSenseDevice(UIntPtr dev);

            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool CreateDS4Device(UIntPtr server, out UIntPtr dev, uint bus, [MarshalAs(UnmanagedType.I1)] bool attach, ushort vid, ushort pid, IntPtr meta);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDS4DeviceState(UIntPtr dev, Ds4State state);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetDS4OutputCallback(UIntPtr dev, Ds4OutputCallback cb);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool RemoveDS4Device(UIntPtr dev);

            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool CreateXbox360Device(UIntPtr server, out UIntPtr dev, uint bus, [MarshalAs(UnmanagedType.I1)] bool attach, ushort vid, ushort pid, byte subType);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetXbox360DeviceState(UIntPtr dev, X360State state);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool SetXbox360RumbleCallback(UIntPtr dev, RumbleCallback cb);
            [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)]
            public static extern bool RemoveXbox360Device(UIntPtr dev);
        }

        static UIntPtr server = UIntPtr.Zero;
        static readonly Lib.LogCallback LibLog = OnLibLog; // held here: libVIIPER keeps calling it
        static string libError;

        /// <summary>libVIIPER's messages (info and up) for diagnostics: %LOCALAPPDATA%\PS5 Game Launcher\libviiper.log.</summary>
        static void OnLibLog(int level, IntPtr message)
        {
            if (level < 0) return;
            var text = message == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(message);
            if (level >= 8) libError = text;
            try
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PS5 Game Launcher");
                var file = Path.Combine(dir, "libviiper.log");
                lock (LibLog)
                {
                    Directory.CreateDirectory(dir);
                    var info = new FileInfo(file);
                    if (info.Exists && info.Length > 512 * 1024) info.Delete();
                    File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss.fff") + (level >= 8 ? " error " : level >= 4 ? " warn  " : " info  ") + text + Environment.NewLine);
                }
            }
            catch { }
        }

        /// <summary>usbip-win2, the driver libVIIPER attaches its devices with (the official VIIPER setup installs it).</summary>
        static bool UsbIpInstalled()
        {
            using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\usbip2_ude")) return k != null;
        }

        static string LibFailure(string what)
        {
            return what + (libError != null ? ": " + libError : "");
        }

        static bool SetupViiper()
        {
            try
            {
                if (!UsbIpInstalled())
                {
                    viiper = "nodriver";
                    lastError = "usbip-win2 isn't installed";
                    return false;
                }
                if (server == UIntPtr.Zero)
                {
                    // libVIIPER is Go, which reads this when the DLL loads (its first call,
                    // below). Its USB/IP traffic (a virtual controller is polled every
                    // millisecond) spread over every core cost twice the CPU in thread
                    // wake-ups (measured 2026-10-18).
                    if (Environment.GetEnvironmentVariable("GOMAXPROCS") == null) Environment.SetEnvironmentVariable("GOMAXPROCS", "2");
                    foreach (var addr in Lib.Addrs)
                    {
                        // IPv6 can be switched off; then localhost is 127.0.0.1 only.
                        var config = new Lib.ServerConfig { Addr = addr, ConnectionTimeoutMs = 30000, DeviceConnectTimeoutMs = 5000, FlushIntervalMs = 1 };
                        UIntPtr s;
                        if (Lib.NewUSBServer(ref config, out s, LibLog)) { server = s; break; }
                    }
                    if (server == UIntPtr.Zero) throw new InvalidOperationException(LibFailure("libVIIPER couldn't start its USB/IP server"));
                }
                uint bus = 0;
                if (!Lib.CreateUSBBus(server, ref bus)) throw new InvalidOperationException(LibFailure("libVIIPER couldn't create a USB bus"));
                busId = (int)bus;
                viiper = "ok";
                return true;
            }
            catch (DllNotFoundException)
            {
                viiper = "missing";
                lastError = "libVIIPER.dll is missing";
                return false;
            }
            catch (Exception e)
            {
                viiper = "error";
                lastError = e.Message;
                return false;
            }
        }

        static string LibVersion()
        {
            try
            {
                var dll = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "libVIIPER.dll");
                return File.Exists(dll) ? System.Diagnostics.FileVersionInfo.GetVersionInfo(dll).ProductVersion : null;
            }
            catch { return null; }
        }

        /// <summary>What a DualSense is shown to games as: dualsense | dualshock4 | xbox360.</summary>
        static string emulation = "dualsense";

        class Virtual
        {
            public string Path;      // real DualSense device path
            public string Kind;      // dualsense | dualsenseedge | dualshock4 | xbox360
            public UIntPtr Dev;
            public string DevId;
            public bool Bluetooth;
            public bool VibrationV2; // the real pad takes the newer rumble encoding
            public byte[] Last = new byte[33]; // last DualSense-layout frame
            public byte[] Raw;       // last input report in USB layout (DualSense / Edge)
            public long NextPush;    // capped polling rate: when the next stick/motion-only update may go
            public long PushedButtons = -1; // buttons and d-pad of the last state the game got
            public int Battery = -1; // battery byte last given to the virtual pad
            public byte[] LastOut;   // last rumble / lights from a DualShock 4 / Xbox pad
            public PadWriter Out;
            public BluetoothHaptics Haptics; // over Bluetooth: the game's HD haptics
            public BluetoothSpeaker Speaker; // over Bluetooth: the game's controller-speaker sound
            public WiredOutput Sound;        // over USB: the game's controller audio on the pad's own audio device
            public int FullAsks;     // calibration reads tried (Bluetooth: switches to full reports)
            public int LastFullAsk;
            public int GameOutputs;  // output reports the game sent (status, for diagnostics)
            public int XSlot = -1;   // for a real Xbox controller: its XInput slot (helper's view)
            public Lib.X360State XLast; // its last state
            public uint XPacket;     // XInput packet number of that state
            public bool XMuted;
            // Handed to libVIIPER: kept with the device so they live as long as it.
            public Lib.OutputCallback OnOutput;
            public Lib.PcmCallback OnHaptics, OnAudio;
            public Lib.ResetCallback OnReset;
            public Lib.Ds4OutputCallback OnDs4Output;
            public Lib.RumbleCallback OnRumble;
        }

        static bool IsDualSense(Virtual v) { return v.Kind == "dualsense" || v.Kind == "dualsenseedge"; }

        /// <summary>Firmware update version 2.21 or newer (always on an Edge): the "vibration v2" rumble encoding.</summary>
        static bool UsesVibrationV2(string path, bool edge)
        {
            if (edge) return true;
            try
            {
                using (var h = CreateFile(path, 0x80000000 | 0x40000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) return false;
                    var b = new byte[Math.Max(Pad.FeatureReportLength(h), 64)];
                    b[0] = 0x20; // firmware info
                    if (!HidD_GetFeature(h, b, b.Length) || b[0] != 0x20) return false;
                    return (b[44] | b[45] << 8) >= 0x0215;
                }
            }
            catch { return false; }
        }

        static Virtual Create(string path, string pid)
        {
            var v = new Virtual { Path = path, Bluetooth = path.IndexOf("{00001124", StringComparison.OrdinalIgnoreCase) >= 0 };
            v.Kind = emulation == "dualsense" ? (pid == "0df2" ? "dualsenseedge" : "dualsense") : emulation;
            v.VibrationV2 = UsesVibrationV2(path, pid == "0df2");
            v.Out = new PadWriter(path, v.Bluetooth);
            UIntPtr dev;
            bool ok;
            if (v.Kind == "xbox360")
            {
                XInputExpectVirtual();
                ok = Lib.CreateXbox360Device(server, out dev, (uint)busId, true, 0, 0, 0);
            }
            else if (v.Kind == "dualshock4") ok = Lib.CreateDS4Device(server, out dev, (uint)busId, true, 0, 0, IntPtr.Zero);
            else
            {
                // The virtual DualSense brings a speaker, which Windows makes the default playback device.
                var defaults = Endpoints.Defaults();
                ok = v.Kind == "dualsenseedge"
                    ? Lib.CreateDualSenseEdgeDevice(server, out dev, (uint)busId, true, 0, 0, IntPtr.Zero)
                    : Lib.CreateDualSenseDevice(server, out dev, (uint)busId, true, 0, 0, IntPtr.Zero);
                if (ok) Endpoints.KeepDefaults(defaults);
            }
            if (!ok)
            {
                v.Out.Dispose();
                throw new InvalidOperationException(LibFailure("libVIIPER couldn't add the virtual controller"));
            }
            v.Dev = dev;
            v.DevId = dev.ToString();
            Wire(v);
            return v;
        }

        /// <summary>What the game sends the virtual pad, on to the real one.</summary>
        static void Wire(Virtual v)
        {
            if (v.Kind == "xbox360")
            {
                v.OnRumble = (h, left, right) => Feedback(v, new byte[] { left, right });
                Lib.SetXbox360RumbleCallback(v.Dev, v.OnRumble);
                return;
            }
            if (v.Kind == "dualshock4")
            {
                v.OnDs4Output = (h, flags, small, large, r, g, b, on, off) => Feedback(v, new byte[] { flags, small, large, r, g, b, on, off });
                Lib.SetDS4OutputCallback(v.Dev, v.OnDs4Output);
                return;
            }
            v.OnOutput = (h, state) =>
            {
                var p = new byte[47];
                Marshal.Copy(state, p, 0, p.Length);
                GameOutput(v, p);
            };
            Lib.SetDualSenseOutputCallback(v.Dev, v.OnOutput);
            if (v.Bluetooth)
            {
                v.Haptics = new BluetoothHaptics(v.Out);
                v.Speaker = NewSpeaker(v);
                v.OnHaptics = (h, pcm, length) => v.Haptics.Push(pcm, (int)length);
                v.OnReset = h =>
                {
                    v.Haptics.Reset();
                    if (v.Speaker != null) v.Speaker.Reset();
                };
                Lib.SetDualSenseRealtimeHapticsCallback(v.Dev, v.OnHaptics);
                Lib.SetDualSenseSpeakerResetCallback(v.Dev, v.OnReset);
                if (v.Speaker != null)
                {
                    v.OnAudio = (h, pcm, length) => v.Speaker.Push(pcm, (int)length);
                    Lib.SetDualSenseAudioOutCallback(v.Dev, v.OnAudio);
                }
            }
            else
            {
                var endpoint = Endpoints.ForDevice(v.Path);
                if (endpoint == null) return;
                v.Sound = new WiredOutput(endpoint);
                v.OnAudio = (h, pcm, length) => v.Sound.Push(pcm, (int)length);
                Lib.SetDualSenseAudioOutCallback(v.Dev, v.OnAudio);
            }
        }

        static void Destroy(Virtual v)
        {
            try
            {
                if (v.Kind == "xbox360")
                {
                    Lib.SetXbox360RumbleCallback(v.Dev, null);
                    Lib.RemoveXbox360Device(v.Dev);
                }
                else if (v.Kind == "dualshock4")
                {
                    Lib.SetDS4OutputCallback(v.Dev, null);
                    Lib.RemoveDS4Device(v.Dev);
                }
                else
                {
                    Lib.SetDualSenseOutputCallback(v.Dev, null);
                    Lib.SetDualSenseRealtimeHapticsCallback(v.Dev, null);
                    Lib.SetDualSenseSpeakerResetCallback(v.Dev, null);
                    Lib.SetDualSenseAudioOutCallback(v.Dev, null);
                    Lib.RemoveDualSenseDevice(v.Dev);
                }
            }
            catch { }
            if (v.Sound != null) v.Sound.Dispose();
            if (v.Speaker != null) v.Speaker.Dispose();
            if (v.Out != null) v.Out.Dispose();
            if (v.Kind == "xbox360") XInputForgetVirtual(v.DevId);
        }

        /* ---------------- DualSense frame -> other pads ---------------- */

        /// <summary>VIIPER DualShock 4 state (31 bytes) from a DualSense frame.</summary>
        static byte[] ToDs4(byte[] f)
        {
            var d = new byte[31];
            Array.Copy(f, 0, d, 0, 4);                         // sticks
            uint ds = (uint)(f[4] | (f[5] << 8) | (f[6] << 16) | (f[7] << 24));
            int b = (int)(ds & 0xFFF0);                        // face, shoulders, share, options, L3, R3: same bits
            if ((ds & 0x10000) != 0) b |= 0x0001;              // PS
            if ((ds & 0x20000) != 0) b |= 0x0002;              // touchpad click
            d[4] = (byte)b; d[5] = (byte)(b >> 8);
            d[6] = f[8];                                       // d-pad
            d[7] = f[9]; d[8] = f[10];                         // L2 / R2
            for (int t = 0; t < 2; t++)
            {
                int at = 11 + t * 5, to = 9 + t * 5;
                d[to] = f[at]; d[to + 1] = f[at + 1];          // x (same range)
                int y = f[at + 2] | (f[at + 3] << 8);
                PutU16(d, to + 2, y * 942 / 1080);             // the DS4 touchpad is shorter
                d[to + 4] = f[at + 4];
            }
            Array.Copy(f, 21, d, 19, 12);                      // gyro + accel (near-identical scales)
            return d;
        }

        /// <summary>VIIPER Xbox 360 state (20 bytes) from a DualSense frame.</summary>
        static byte[] ToX360(byte[] f)
        {
            var x = new byte[20];
            uint ds = (uint)(f[4] | (f[5] << 8) | (f[6] << 16) | (f[7] << 24));
            int b = f[8] & 0x0F;                               // d-pad: same bits
            if ((ds & 0x2000) != 0) b |= 0x0010;               // Options -> Start
            if ((ds & 0x1000) != 0 || (ds & 0x20000) != 0) b |= 0x0020; // Create / touchpad -> Back
            if ((ds & 0x4000) != 0) b |= 0x0040;               // L3
            if ((ds & 0x8000) != 0) b |= 0x0080;               // R3
            if ((ds & 0x0100) != 0) b |= 0x0100;               // L1
            if ((ds & 0x0200) != 0) b |= 0x0200;               // R1
            if ((ds & 0x0020) != 0) b |= 0x1000;               // Cross -> A
            if ((ds & 0x0040) != 0) b |= 0x2000;               // Circle -> B
            if ((ds & 0x0010) != 0) b |= 0x4000;               // Square -> X
            if ((ds & 0x0080) != 0) b |= 0x8000;               // Triangle -> Y
            x[0] = (byte)b; x[1] = (byte)(b >> 8);
            x[4] = f[9]; x[5] = f[10];
            PutI16(x, 6, Axis((sbyte)f[0]));
            PutI16(x, 8, Axis(-(sbyte)f[1]));                  // Xbox: up is positive
            PutI16(x, 10, Axis((sbyte)f[2]));
            PutI16(x, 12, Axis(-(sbyte)f[3]));
            return x;
        }

        static int Axis(int v) { v = Math.Max(-128, Math.Min(127, v)); return v < 0 ? v * 256 : v * 258; }
        static void PutI16(byte[] f, int at, int v) { f[at] = (byte)v; f[at + 1] = (byte)(v >> 8); }

        static short I16(byte[] f, int at) { return (short)(f[at] | f[at + 1] << 8); }

        /// <summary>libVIIPER's DualShock 4 state from the 31-byte frame ToDs4 makes.</summary>
        static Lib.Ds4State Ds4State(byte[] d)
        {
            return new Lib.Ds4State
            {
                LX = (sbyte)d[0], LY = (sbyte)d[1], RX = (sbyte)d[2], RY = (sbyte)d[3],
                Buttons = (ushort)(d[4] | d[5] << 8), DPad = d[6], L2 = d[7], R2 = d[8],
                Touch1X = (ushort)I16(d, 9), Touch1Y = (ushort)I16(d, 11), Touch1Active = d[13],
                Touch2X = (ushort)I16(d, 14), Touch2Y = (ushort)I16(d, 16), Touch2Active = d[18],
                GyroX = I16(d, 19), GyroY = I16(d, 21), GyroZ = I16(d, 23),
                AccelX = I16(d, 25), AccelY = I16(d, 27), AccelZ = I16(d, 29),
            };
        }

        /// <summary>libVIIPER's Xbox 360 state from the 20-byte frame ToX360 makes.</summary>
        static Lib.X360State X360State(byte[] x)
        {
            return new Lib.X360State
            {
                Buttons = (uint)(x[0] | x[1] << 8 | x[2] << 16 | x[3] << 24), LT = x[4], RT = x[5],
                LX = I16(x, 6), LY = I16(x, 8), RX = I16(x, 10), RY = I16(x, 12),
            };
        }

        /* ---------------- Input: real -> virtual ---------------- */

        [DllImport("hid.dll")] static extern bool HidD_GetFeature(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len);

        /// <summary>
        /// A Bluetooth DualSense sends short reports (no motion, no touchpad) until
        /// its calibration report (0x05) has been read. Tried a few times, a second apart.
        /// </summary>
        static void AskFullReports(Virtual v)
        {
            if (v.FullAsks >= 3 || Environment.TickCount - v.LastFullAsk < 1000) return;
            v.FullAsks++;
            v.LastFullAsk = Environment.TickCount;
            try
            {
                using (var h = CreateFile(v.Path, 0x80000000 | 0x40000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) return;
                    // Windows wants a buffer as long as the device's longest feature report.
                    var b = new byte[Math.Max(Pad.FeatureReportLength(h), 64)];
                    b[0] = 0x05;
                    HidD_GetFeature(h, b, b.Length);
                }
            }
            catch { }
        }

        static void PutU16(byte[] f, int at, int v) { f[at] = (byte)v; f[at + 1] = (byte)(v >> 8); }

        /// <summary>DualSense HID input report -> VIIPER's 33-byte DualSense state.</summary>
        static byte[] State(byte[] b, int n, bool bluetooth)
        {
            var f = new byte[33];
            int o;
            bool full;
            // Report id and connection decide the layout, never the length: Windows pads
            // every report to the longest one, so Bluetooth's short report is 78 bytes too.
            if (!bluetooth && b[0] == 0x01 && n >= 64) { o = 1; full = true; }     // USB
            else if (bluetooth && b[0] == 0x31 && n >= 64) { o = 2; full = true; } // Bluetooth, full report
            else if (bluetooth && b[0] == 0x01 && n >= 10) { o = 1; full = false; } // Bluetooth, short report
            else return null;
            int lx = b[o], ly = b[o + 1], rx = b[o + 2], ry = b[o + 3];
            int l2, r2, b0, b1, b2;
            if (full) { l2 = b[o + 4]; r2 = b[o + 5]; b0 = b[o + 7]; b1 = b[o + 8]; b2 = b[o + 9]; }
            else { b0 = b[o + 4]; b1 = b[o + 5]; b2 = b[o + 6]; l2 = b[o + 7]; r2 = b[o + 8]; }
            f[0] = (byte)(sbyte)(lx - 128);
            f[1] = (byte)(sbyte)(ly - 128);
            f[2] = (byte)(sbyte)(rx - 128);
            f[3] = (byte)(sbyte)(ry - 128);
            // Same bit layout as the report: face buttons, then shoulders/sticks, then PS/touchpad/mute.
            // The PS button stays with the launcher (it opens the quick menu), like on a PS5.
            uint buttons = (uint)(b0 & 0xF0) | ((uint)b1 << 8) | ((uint)(b2 & ~0x01) << 16);
            // While recording is on, the Create button opens the capture menu instead.
            if (StripCreate) buttons &= ~0x1000u;
            f[4] = (byte)buttons; f[5] = (byte)(buttons >> 8); f[6] = (byte)(buttons >> 16); f[7] = (byte)(buttons >> 24);
            int hat = b0 & 0x0F;
            byte dpad = 0;
            if (hat == 0 || hat == 1 || hat == 7) dpad |= 0x01;
            if (hat == 3 || hat == 4 || hat == 5) dpad |= 0x02;
            if (hat == 5 || hat == 6 || hat == 7) dpad |= 0x04;
            if (hat == 1 || hat == 2 || hat == 3) dpad |= 0x08;
            f[8] = dpad;
            f[9] = (byte)l2;
            f[10] = (byte)r2;
            if (full)
            {
                for (int t = 0; t < 2; t++)
                {
                    int p = o + 32 + t * 4, at = 11 + t * 5;
                    bool active = (b[p] & 0x80) == 0;
                    int x = b[p + 1] | ((b[p + 2] & 0x0F) << 8);
                    int y = (b[p + 2] >> 4) | (b[p + 3] << 4);
                    PutU16(f, at, Math.Min(x, 1919));
                    PutU16(f, at + 2, Math.Min(y, 1079));
                    f[at + 4] = (byte)(active ? 1 : 0);
                }
                Array.Copy(b, o + 15, f, 21, 12); // gyro x/y/z, accel x/y/z (raw int16)
            }
            else
            {
                PutU16(f, 31, unchecked((ushort)-8192)); // resting, flat
            }
            return f;
        }

        /// <summary>Same motion, nothing pressed, sticks centred.</summary>
        static byte[] Neutral(byte[] last)
        {
            var f = new byte[33];
            Array.Copy(last, 21, f, 21, 12);
            return f;
        }

        public static void OnReport(string path, string pid, byte[] buf, int n)
        {
            if (!Enabled || (pid != "0ce6" && pid != "0df2")) return;
            Virtual v;
            lock (Gate) Pads.TryGetValue(path, out v);
            if (v == null) return;
            if (v.Bluetooth && buf[0] == 0x01) AskFullReports(v);
            var f = State(buf, n, v.Bluetooth);
            if (f == null) return;
            v.Last = f;
            if (IsDualSense(v)) v.Raw = RawReport(buf, n, v.Bluetooth);
            if (!PushNow(v)) return;
            Push(v);
        }

        // Polling rate games get (Settings > Controllers), per connection; 0 = the pad's own.
        static volatile int RateUsb, RateBt;

        public static object SetRate(int usb, int bt)
        {
            RateUsb = Math.Max(0, usb);
            RateBt = Math.Max(0, bt);
            return true;
        }

        /// <summary>
        /// With a capped rate, a press or release (buttons, d-pad) still goes at once;
        /// sticks, triggers and motion at most once per period (the newest then).
        /// </summary>
        static bool PushNow(Virtual v)
        {
            int rate = v.Bluetooth ? RateBt : RateUsb;
            if (rate <= 0) return true;
            var f = v.Last;
            long buttons = (long)BitConverter.ToUInt32(f, 4) | (long)f[8] << 32;
            long now = System.Diagnostics.Stopwatch.GetTimestamp();
            if (buttons == v.PushedButtons && now < v.NextPush) return false;
            v.PushedButtons = buttons;
            v.NextPush = now + System.Diagnostics.Stopwatch.Frequency / rate;
            return true;
        }

        /// <summary>
        /// The real pad's input report in USB layout (report 0x01, 64 bytes): over
        /// Bluetooth, report 0x31 is the same after its extra second byte. The short
        /// Bluetooth report (before the pad sends full ones) only has sticks, buttons
        /// and triggers. It becomes libVIIPER's state (DsStateOf) in Push.
        /// </summary>
        static byte[] RawReport(byte[] b, int n, bool bluetooth)
        {
            var r = new byte[64];
            if (!bluetooth && b[0] == 0x01 && n >= 64) Array.Copy(b, r, 64);
            else if (bluetooth && b[0] == 0x31 && n >= 65)
            {
                r[0] = 0x01;
                Array.Copy(b, 2, r, 1, 63);
            }
            else
            {
                r[0] = 0x01;
                Array.Copy(b, 1, r, 1, 4);           // sticks
                r[5] = b[8]; r[6] = b[9];             // L2, R2
                r[8] = b[5]; r[9] = b[6]; r[10] = b[7]; // d-pad and buttons
                r[33] = r[37] = 0x80;                 // no touches
                PutU16(r, 26, unchecked((ushort)-8192)); // resting, flat
            }
            // The PS button stays with the launcher (it opens the quick menu), like on a PS5.
            r[10] &= 0xFE;
            // While recording is on, the Create button opens the capture menu instead.
            if (StripCreate) r[9] &= 0xEF;
            return r;
        }

        static short I16At(byte[] b, int at) { return (short)(b[at] | b[at + 1] << 8); }

        /// <summary>libVIIPER's DualSense state from a USB-layout input report.</summary>
        static Lib.DsState DsStateOf(byte[] r)
        {
            int hat = r[8] & 0x0F;
            byte dpad = 0;
            if (hat == 0 || hat == 1 || hat == 7) dpad |= 0x01;
            if (hat == 3 || hat == 4 || hat == 5) dpad |= 0x02;
            if (hat == 5 || hat == 6 || hat == 7) dpad |= 0x04;
            if (hat == 1 || hat == 2 || hat == 3) dpad |= 0x08;
            return new Lib.DsState
            {
                LX = (sbyte)(r[1] - 128), LY = (sbyte)(r[2] - 128), RX = (sbyte)(r[3] - 128), RY = (sbyte)(r[4] - 128),
                L2 = r[5], R2 = r[6],
                // Same bits as the report: face buttons, shoulders and sticks, then PS / touchpad / mute (and Edge's).
                Buttons = (uint)(r[8] & 0xF0) | (uint)r[9] << 8 | (uint)r[10] << 16,
                DPad = dpad,
                Touch1Active = (byte)((r[33] & 0x80) == 0 ? 1 : 0), Touch1Tracking = (byte)(r[33] & 0x7F),
                Touch1X = (ushort)(r[34] | (r[35] & 0x0F) << 8), Touch1Y = (ushort)(r[35] >> 4 | r[36] << 4),
                Touch2Active = (byte)((r[37] & 0x80) == 0 ? 1 : 0), Touch2Tracking = (byte)(r[37] & 0x7F),
                Touch2X = (ushort)(r[38] | (r[39] & 0x0F) << 8), Touch2Y = (ushort)(r[39] >> 4 | r[40] << 4),
                GyroX = I16At(r, 16), GyroY = I16At(r, 18), GyroZ = I16At(r, 20),
                AccelX = I16At(r, 22), AccelY = I16At(r, 24), AccelZ = I16At(r, 26),
            };
        }

        /// <summary>The same report with nothing pressed, sticks centred (motion kept).</summary>
        static byte[] NeutralRaw(byte[] raw)
        {
            var r = (byte[])raw.Clone();
            r[1] = r[2] = r[3] = r[4] = 0x80;
            r[5] = r[6] = 0;
            r[8] = 0x08; // d-pad released, no face buttons
            r[9] = r[10] = 0;
            r[33] |= 0x80;
            r[37] |= 0x80;
            return r;
        }

        /// <summary>Send the pad's current state (or a neutral one while muted) in its type's format.</summary>
        static void Push(Virtual v)
        {
            try
            {
                if (IsDualSense(v))
                {
                    var raw = v.Raw;
                    if (raw == null) return;
                    if (Muted) raw = NeutralRaw(raw);
                    Lib.SetDualSenseDeviceState(v.Dev, DsStateOf(raw));
                    // The battery games see (state reports leave it out).
                    if (raw[53] != v.Battery)
                    {
                        v.Battery = raw[53];
                        var meta = new Lib.DsMeta { BatteryStatus = raw[53] };
                        Lib.SetDualSenseMetaState(v.Dev, ref meta);
                    }
                }
                else if (v.XSlot >= 0) Lib.SetXbox360DeviceState(v.Dev, Muted ? new Lib.X360State() : v.XLast);
                else
                {
                    var f = Muted ? Neutral(v.Last) : v.Last;
                    if (v.Kind == "dualshock4") Lib.SetDS4DeviceState(v.Dev, Ds4State(ToDs4(f)));
                    else Lib.SetXbox360DeviceState(v.Dev, X360State(ToX360(f)));
                }
            }
            catch { }
        }

        /* ---------------- Our own virtual Xbox 360 pads ----------------
           With "emulate as Xbox" the virtual pad shows up in XInput; the XInput
           reader must not take it for a real controller. */

        static readonly HashSet<int> VirtualSlots = new HashSet<int>();
        static readonly Dictionary<string, int> SlotOfDev = new Dictionary<string, int>();
        static int expectVirtual;
        static long expectUntil;

        /// <summary>A virtual Xbox 360 pad is about to be added: the next new XInput slot is it.</summary>
        static void XInputExpectVirtual()
        {
            lock (VirtualSlots)
            {
                expectVirtual++;
                expectUntil = Environment.TickCount + 6000;
            }
        }

        static void XInputForgetVirtual(string devId)
        {
            lock (VirtualSlots)
            {
                int slot;
                if (devId != null && SlotOfDev.TryGetValue(devId, out slot))
                {
                    SlotOfDev.Remove(devId);
                    VirtualSlots.Remove(slot);
                }
            }
        }

        /// <summary>Called by the XInput reader when a slot becomes connected. True: one of ours.</summary>
        public static bool XInputSlotAppeared(int slot)
        {
            lock (VirtualSlots)
            {
                if (VirtualSlots.Contains(slot)) return true;
                // Ours are Xbox 360 controllers (045E:028E): a controller that says otherwise is a real one.
                var product = Pad.XInputProduct(slot);
                if (expectVirtual > 0 && Environment.TickCount - expectUntil < 0 && (product < 0 || product == 0x028E))
                {
                    expectVirtual--;
                    VirtualSlots.Add(slot);
                    // Tie it to the newest Xbox 360 device so it can be released later.
                    lock (Gate)
                    {
                        var v = Pads.Values.Concat(XboxPads.Values).Where(p => p.Kind == "xbox360" && p.DevId != null && !SlotOfDev.ContainsKey(p.DevId)).LastOrDefault();
                        if (v != null) SlotOfDev[v.DevId] = slot;
                    }
                    return true;
                }
                return false;
            }
        }

        /// <summary>A slot went empty: whatever was there, it can be a real pad next time.</summary>
        public static void XInputSlotGone(int slot)
        {
            bool ours;
            lock (VirtualSlots)
            {
                ours = VirtualSlots.Remove(slot);
                foreach (var k in SlotOfDev.Where(p => p.Value == slot).Select(p => p.Key).ToList()) SlotOfDev.Remove(k);
            }
            if (!ours) XboxGone(slot);
        }

        /* ---------------- Xbox controllers ----------------
           A real Xbox controller is handed over like the DualSense, through XInput:
           HidHide hides its XInput device from games (the "XINPUT compatible HID
           device" of an Xbox One/Series controller, the XUSB device of an Xbox 360
           one), and games get a virtual Xbox 360 controller fed from it, quiet while
           a menu is open, its rumble going back to the real one. Games on
           Windows.Gaming.Input or GameInput reach Xbox One/Series controllers through
           the Xbox driver's own channel, which HidHide can't filter (tested
           2026-10-18), so they still see the real one too. They only read it while
           they are in front, though, and the quick menu is in front while open.
           These devices are never restarted: restarting an Xbox One/Series
           controller took its XInput device away until Windows restarted. */

        static readonly Dictionary<int, Virtual> XboxPads = new Dictionary<int, Virtual>(); // real XInput slot -> its virtual pad
        static readonly HashSet<int> XboxCreating = new HashSet<int>();
        static readonly HashSet<string> XboxHidden = new HashSet<string>();
        static readonly Guid XusbInterface = new Guid("EC87F1E3-C13B-4100-B5F7-8B84D54260CB");

        /// <summary>A virtual pad for a real Xbox controller is live (the XInput reader polls faster then).</summary>
        public static bool XboxActive
        {
            get { lock (Gate) return XboxPads.Count > 0; }
        }

        /// <summary>Hide every real XInput device from games (called again as controllers connect).</summary>
        public static void HideXboxDevices()
        {
            if (!Enabled || hidhide != "ok") return;
            foreach (var path in Pad.InterfacePaths(XusbInterface))
            {
                if (Pad.IsVirtual(path)) continue;
                var inst = Pad.InstancePath(path);
                lock (Gate)
                {
                    if (!XboxHidden.Add(inst)) continue;
                }
                if (!sessionUnsupported)
                {
                    try { Put(ADD_SESSION, ToMulti(new[] { inst })); }
                    catch { sessionUnsupported = true; }
                }
                if (sessionUnsupported)
                {
                    try { AddToBlacklist(inst); } catch (Exception e) { lastError = e.Message; }
                }
            }
        }

        /// <summary>The XInput reader's state of a real controller: its virtual pad gets it (made on first sight).</summary>
        public static void OnXInput(int slot, uint packet, ushort buttons, byte lt, byte rt, short lx, short ly, short rx, short ry)
        {
            if (!Enabled || busId < 0 || server == UIntPtr.Zero) return;
            Virtual v;
            lock (Gate)
            {
                if (!XboxPads.TryGetValue(slot, out v))
                {
                    // One at a time: the XInput slot a new virtual pad gets is told apart by order.
                    if (XboxCreating.Count > 0) return;
                    XboxCreating.Add(slot);
                    new Thread(() => CreateXbox(slot)) { IsBackground = true, Name = "xbox-pad" }.Start();
                    return;
                }
            }
            var muted = Muted;
            if (packet == v.XPacket && muted == v.XMuted) return; // nothing new
            v.XPacket = packet;
            v.XMuted = muted;
            // The Guide button stays with the launcher (it opens the quick menu).
            v.XLast = new Lib.X360State { Buttons = (uint)(buttons & ~0x0400), LT = lt, RT = rt, LX = lx, LY = ly, RX = rx, RY = ry };
            Push(v);
        }

        static void CreateXbox(int slot)
        {
            try
            {
                HideXboxDevices();
                lock (Change)
                {
                    if (!Enabled || busId < 0) return;
                    var v = new Virtual { Path = "xinput:" + slot, Kind = "xbox360", XSlot = slot };
                    XInputExpectVirtual();
                    UIntPtr dev;
                    if (!Lib.CreateXbox360Device(server, out dev, (uint)busId, true, 0, 0, 0))
                    {
                        lastError = LibFailure("libVIIPER couldn't add the virtual controller");
                        Notify();
                        return;
                    }
                    v.Dev = dev;
                    v.DevId = dev.ToString();
                    v.OnRumble = (h, left, right) => Pad.XInputRumble(slot, left, right);
                    Lib.SetXbox360RumbleCallback(dev, v.OnRumble);
                    lock (Gate) XboxPads[slot] = v;
                }
                Notify();
                // Its XInput slot shows up shortly: the next pad waits for it.
                for (int i = 0; i < 40 && ExpectingVirtual; i++) Thread.Sleep(100);
            }
            catch (Exception e)
            {
                lastError = e.Message;
            }
            finally
            {
                lock (Gate) XboxCreating.Remove(slot);
            }
        }

        /// <summary>A real Xbox controller went away: so does its virtual pad.</summary>
        static void XboxGone(int slot)
        {
            Virtual v;
            lock (Gate)
            {
                if (!XboxPads.TryGetValue(slot, out v)) return;
                XboxPads.Remove(slot);
            }
            ThreadPool.QueueUserWorkItem(_ =>
            {
                lock (Change) Destroy(v);
                Notify();
            });
        }

        static List<Virtual> TakeXbox()
        {
            lock (Gate)
            {
                var all = XboxPads.Values.ToList();
                XboxPads.Clear();
                return all;
            }
        }

        public static bool IsVirtualSlot(int slot)
        {
            lock (VirtualSlots) return VirtualSlots.Contains(slot);
        }

        public static bool ExpectingVirtual
        {
            get { lock (VirtualSlots) return expectVirtual > 0 && Environment.TickCount - expectUntil < 0; }
        }

        /// <summary>A real DualSense showed up (called from the HID reader).</summary>
        public static void OnConnected(string path, string pid)
        {
            if (!Enabled || (pid != "0ce6" && pid != "0df2") || busId < 0 || Pad.IsVirtual(path)) return;
            lock (Gate) if (Pads.ContainsKey(path)) return;
            Hide(path);
            try
            {
                lock (Change)
                {
                    if (!Enabled || busId < 0) return;
                    lock (Gate) if (Pads.ContainsKey(path)) return;
                    var v = Create(path, pid);
                    lock (Gate) Pads[path] = v;
                }
                Notify();
            }
            catch (Exception e)
            {
                lastError = e.Message;
                Notify();
            }
        }

        public static void OnGone(string path)
        {
            Virtual v;
            lock (Gate)
            {
                if (!Pads.TryGetValue(path, out v)) return;
                Pads.Remove(path);
            }
            lock (Change) Destroy(v);
            Notify();
        }

        /* ---------------- Output: game -> real controller ---------------- */

        static uint[] crcTable;
        static uint Crc32(byte[] data, int start, int len, uint crc)
        {
            if (crcTable == null)
            {
                crcTable = new uint[256];
                for (uint i = 0; i < 256; i++)
                {
                    var c = i;
                    for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
                    crcTable[i] = c;
                }
            }
            for (int i = start; i < start + len; i++) crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
            return crc;
        }

        [DllImport("kernel32", SetLastError = true)]
        static extern bool WriteFile(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len, out int written, IntPtr overlapped);

        /// <summary>Rumble and lights from a virtual DualShock 4 / Xbox 360 pad.</summary>
        static void Feedback(Virtual v, byte[] buf)
        {
            lock (v)
            {
                if (v.LastOut != null && buf.SequenceEqual(v.LastOut)) return;
                v.LastOut = buf;
            }
            if (v.Kind == "xbox360") WriteOutput(v, buf[1], buf[0], 0, 0, 0, 0, false);
            // flags: 0x01 rumble, 0x02 lightbar
            else if ((buf[0] & 0x02) != 0) WriteOutput(v, buf[1], buf[2], buf[3], buf[4], buf[5], 0, true);
            else WriteOutput(v, buf[1], buf[2], 0, 0, 0, 0, false);
        }

        /// <summary>Rumble, lightbar and player lights to the real DualSense.</summary>
        static void WriteOutput(Virtual v, byte small, byte large, byte r, byte g, byte b, byte players, bool lights)
        {
            var p = new byte[47];
            p[0] = 0x01 | 0x02; // rumble (compatible vibration)
            p[1] = (byte)(lights ? 0x04 | 0x10 : 0); // lightbar + player lights (left alone for Xbox / DS4 without a colour)
            p[2] = small;
            p[3] = large;
            p[43] = players;
            p[44] = r;
            p[45] = g;
            p[46] = b;
            v.Out.Post(p);
        }

        /// <summary>
        /// What a game sent the virtual DualSense (its output report 0x02 without the
        /// id: rumble, adaptive trigger effects, lights, audio settings), on to the
        /// real pad. As in DualSense Client, rumble is played as compatible vibration
        /// in the encoding the pad's firmware takes.
        /// </summary>
        static void GameOutput(Virtual v, byte[] p)
        {
            Interlocked.Increment(ref v.GameOutputs);
            if (v.Speaker != null) v.Speaker.Observe(p);
            bool rumble = (p[0] & 0x01) != 0 || (p[38] & 0x04) != 0;
            p[0] &= 0xFC;
            p[38] &= 0xFB;
            if (rumble)
            {
                p[0] |= 0x02; // rumble, not haptics
                if (v.VibrationV2) p[38] |= 0x04;
                else p[0] |= 0x01;
            }
            v.Out.Post(p);
        }

        /// <summary>
        /// Writes to one real DualSense on its own thread: output state (report 0x02
        /// over USB, 0x31 over Bluetooth) and, over Bluetooth, HD haptics (0x32). The
        /// Bluetooth link depends on the adapter (measured 2026-10: a Barrot one took
        /// 0x31 ~95 a second and 0x32 ~47, a Realtek one ~680 and ~380), so states that
        /// pile up are merged into one and go first, and haptics are kept to two
        /// reports so they never fall behind the game.
        /// </summary>
        internal sealed class PadWriter : IDisposable
        {
            readonly Microsoft.Win32.SafeHandles.SafeFileHandle handle;
            readonly bool bluetooth;
            public readonly int Length;
            readonly object gate = new object();
            readonly AutoResetEvent wake = new AutoResetEvent(false);
            readonly Queue<byte[]> haptics = new Queue<byte[]>();
            byte[] state, sent;
            byte seq;
            bool held; // BluetoothSpeaker has the pad: it writes, this doesn't
            volatile bool stop;
            public int States, Haptics, Speaker, Failed; // written (status, for diagnostics)

            public PadWriter(string path, bool bluetooth)
            {
                this.bluetooth = bluetooth;
                handle = CreateFile(path, 0x40000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero);
                // Windows only takes writes as long as the device's longest output report
                // (over Bluetooth that is 547 bytes), shorter ones padded.
                Length = Math.Max(handle.IsInvalid ? 0 : Pad.OutputReportLength(handle), bluetooth ? 142 : 48);
                new Thread(Run) { IsBackground = true, Name = "pad-out", Priority = ThreadPriority.AboveNormal }.Start();
            }

            /// <summary>An output state (47 bytes); one still waiting takes in what this one changes.</summary>
            public void Post(byte[] p)
            {
                lock (gate) state = state == null ? p : Merge(state, p);
                wake.Set();
            }

            public void PostHaptics(byte[] report)
            {
                lock (gate)
                {
                    if (held) return; // the speaker stream carries the haptics now
                    haptics.Enqueue(report);
                    while (haptics.Count > 2) haptics.Dequeue();
                }
                wake.Set();
            }

            /// <summary>
            /// While the pad plays speaker sound over Bluetooth it only takes report 0x36
            /// (BluetoothSpeaker): output states wait here for it (TakeState) and haptics
            /// are dropped. Released, what's waiting goes as 0x31 again.
            /// </summary>
            public void Hold(bool on)
            {
                lock (gate)
                {
                    held = on;
                    haptics.Clear();
                }
                wake.Set();
            }

            /// <summary>The output state waiting to be sent (merged), if it changes anything; a copy.</summary>
            public byte[] TakeState()
            {
                lock (gate)
                {
                    var p = state;
                    state = null;
                    if (p == null || (sent != null && p.SequenceEqual(sent))) return null;
                    sent = p;
                    return (byte[])p.Clone();
                }
            }

            /// <summary>An output state as this pad's report (0x31 over Bluetooth), in its sequence.</summary>
            public byte[] StateReport(byte[] p)
            {
                lock (gate) return Report(p);
            }

            /// <summary>Writes a report now, on the caller's thread (BluetoothSpeaker's).</summary>
            public void Write(byte[] r)
            {
                if (stop || handle.IsInvalid) return;
                int written;
                if (!WriteFile(handle, r, r.Length, out written, IntPtr.Zero)) Failed++;
                else if (r[0] == 0x36) Speaker++;
                else if (r[0] == 0x32) Haptics++;
                else States++;
            }

            // Output state fields by the valid flag that makes the pad use them: [flag byte, bit, first, count].
            static readonly int[][] Fields =
            {
                new[] { 0, 0x03, 2, 2 }, new[] { 0, 0x04, 10, 11 }, new[] { 0, 0x08, 21, 11 },
                new[] { 0, 0x10, 4, 1 }, new[] { 0, 0x20, 5, 1 }, new[] { 0, 0x40, 6, 1 }, new[] { 0, 0x80, 7, 1 },
                new[] { 1, 0x01, 8, 1 }, new[] { 1, 0x02, 9, 1 }, new[] { 1, 0x04, 44, 3 }, new[] { 1, 0x10, 43, 1 },
                new[] { 1, 0x20, 39, 1 }, new[] { 1, 0x40, 36, 1 }, new[] { 1, 0x80, 37, 1 },
                new[] { 38, 0x01, 42, 1 }, new[] { 38, 0x02, 41, 1 }, new[] { 38, 0x04, 2, 2 },
            };

            static byte[] Merge(byte[] older, byte[] newer)
            {
                var m = (byte[])older.Clone();
                foreach (var f in Fields)
                    if ((newer[f[0]] & f[1]) != 0) Array.Copy(newer, f[2], m, f[2], f[3]);
                m[0] |= newer[0];
                m[1] |= newer[1];
                m[38] |= newer[38];
                Array.Copy(newer, 32, m, 32, 4); // host timestamp
                return m;
            }

            byte[] Report(byte[] p)
            {
                var r = new byte[Length];
                if (!bluetooth)
                {
                    r[0] = 0x02;
                    Array.Copy(p, 0, r, 1, p.Length);
                    return r;
                }
                r[0] = 0x31;
                r[1] = (byte)(seq << 4);
                seq = (byte)((seq + 1) & 0x0F);
                r[2] = 0x10;
                Array.Copy(p, 0, r, 3, p.Length);
                var crc = Crc32(new byte[] { 0xA2 }, 0, 1, 0xFFFFFFFF);
                crc = ~Crc32(r, 0, 74, crc);
                r[74] = (byte)crc; r[75] = (byte)(crc >> 8); r[76] = (byte)(crc >> 16); r[77] = (byte)(crc >> 24);
                return r;
            }

            void Run()
            {
                while (!stop)
                {
                    wake.WaitOne(100);
                    while (!stop)
                    {
                        byte[] r;
                        lock (gate)
                        {
                            if (held) break;
                            if (state != null)
                            {
                                var p = state;
                                state = null;
                                // The same state again changes nothing on the pad (and costs a Bluetooth packet).
                                if (sent != null && p.SequenceEqual(sent)) continue;
                                sent = p;
                                r = Report(p);
                            }
                            else if (haptics.Count > 0) r = haptics.Dequeue();
                            else break;
                        }
                        if (handle.IsInvalid) continue;
                        int written;
                        if (!WriteFile(handle, r, r.Length, out written, IntPtr.Zero)) Failed++;
                        else if (r[0] == 0x32) Haptics++;
                        else States++;
                    }
                }
                handle.Dispose();
            }

            public void Dispose()
            {
                stop = true;
                wake.Set();
            }
        }

        /// <summary>
        /// A game's HD haptics (the virtual DualSense's rear voice-coil pair from
        /// libVIIPER's realtime haptics lane: 2 channels, 16-bit, 48 kHz) as Bluetooth
        /// report 0x32 in DualSense Client's layout: 32 stereo frames of 8-bit samples.
        /// Each covers 10.7 ms (16 frames of 48 kHz averaged into one: 3 kHz per
        /// actuator, the pad's own rate), about 94 reports a second.
        /// </summary>
        internal sealed class BluetoothHaptics
        {
            const int Factor = 16;
            readonly PadWriter writer;
            readonly object gate = new object();
            readonly byte[] frames = new byte[64];
            byte[] pcm = new byte[0];
            int filled, n, sumLeft, sumRight;
            byte seq, counter;

            public BluetoothHaptics(PadWriter writer) { this.writer = writer; }

            /// <summary>Called on libVIIPER's thread with the PCM of one USB transfer.</summary>
            public void Push(IntPtr data, int length)
            {
                lock (gate)
                {
                    if (pcm.Length < length) pcm = new byte[length];
                    Marshal.Copy(data, pcm, 0, length);
                    for (int i = 0; i + 3 < length; i += 4)
                    {
                        sumLeft += (short)(pcm[i] | pcm[i + 1] << 8);
                        sumRight += (short)(pcm[i + 2] | pcm[i + 3] << 8);
                        if (++n < Factor) continue;
                        frames[filled++] = (byte)(sbyte)(sumLeft / Factor >> 8);
                        frames[filled++] = (byte)(sbyte)(sumRight / Factor >> 8);
                        sumLeft = sumRight = n = 0;
                        if (filled < frames.Length) continue;
                        filled = 0;
                        Send();
                    }
                }
            }

            /// <summary>The game opened, closed or reset the audio stream: start over.</summary>
            public void Reset()
            {
                lock (gate) filled = n = sumLeft = sumRight = 0;
            }

            void Send()
            {
                // Silence is sent too, for as long as the game streams: with gaps the pad's haptics go
                // idle, and short taps (a menu's clicks) then come out wrong. The pad still takes
                // output states in between (checked 2026-10-19: its echoed host timestamp keeps up).
                var r = new byte[writer.Length];
                r[0] = 0x32;
                r[1] = (byte)(seq << 4);
                seq = (byte)((seq + 1) & 0x0F);
                r[2] = 0x91; r[3] = 0x07; // packet 0x11 (sized, 7 bytes): mic off, buffer lengths
                r[4] = 0xFE;
                r[5] = r[6] = r[7] = r[8] = r[9] = 0x40;
                r[10] = counter++;
                r[11] = 0x92; r[12] = 0x40; // packet 0x12 (sized, 64 bytes): haptics
                Array.Copy(frames, 0, r, 13, frames.Length);
                var crc = Crc32(new byte[] { 0xA2 }, 0, 1, 0xFFFFFFFF);
                crc = ~Crc32(r, 0, 138, crc);
                r[138] = (byte)crc; r[139] = (byte)(crc >> 8); r[140] = (byte)(crc >> 16); r[141] = (byte)(crc >> 24);
                writer.PostHaptics(r);
            }
        }

        static string speakerError;

        /// <summary>A Bluetooth DualSense's speaker stream, or null without an Opus encoder (Concentus.dll).</summary>
        static BluetoothSpeaker NewSpeaker(Virtual v)
        {
            try
            {
                return new BluetoothSpeaker(v.Out, NewOpus(), v.VibrationV2);
            }
            catch (Exception e)
            {
                speakerError = "no speaker: " + e.Message;
                return null;
            }
        }

        // Its own method: without Concentus.dll it is this call that fails, not its caller.
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
        static OpusFrameEncoder NewOpus() { return new OpusFrameEncoder(); }

        /// <summary>A Bluetooth report's CRC (seeded with 0xA2) over its first len bytes, written after them.</summary>
        static void PutCrc(byte[] r, int len)
        {
            var crc = Crc32(new byte[] { 0xA2 }, 0, 1, 0xFFFFFFFF);
            crc = ~Crc32(r, 0, len, crc);
            r[len] = (byte)crc; r[len + 1] = (byte)(crc >> 8); r[len + 2] = (byte)(crc >> 16); r[len + 3] = (byte)(crc >> 24);
        }

        /// <summary>
        /// The game's controller-speaker sound (the virtual DualSense's front pair on
        /// its audio interface: 4 channels, 16-bit, 48 kHz) on a Bluetooth pad's own
        /// speaker. Over Bluetooth the pad takes it as Opus, 200 bytes per frame, in
        /// report 0x36: one every 512 frames (10.67 ms), the haptics (the rear pair)
        /// and the output state in the same report. While that stream runs the pad
        /// ignores 0x31 and 0x32, and its rumble motors (rumble is played on the
        /// haptics instead). It opens when the speaker has something to play (report
        /// 0x32 "primes" the pad, a few silent reports warm it up) and closes after a
        /// while of silence, when 0x31 / 0x32 take over again. As in DualSense Client.
        /// The speaker's volume, output path and preamp are the game's own (what a
        /// wired pad gets from it), DualSense Client's defaults until the game sets
        /// them. What happens goes to %LOCALAPPDATA%\PS5 Game Launcher\speaker.log.
        /// </summary>
        internal sealed class BluetoothSpeaker : IDisposable
        {
            const int Frames = 512;     // per report: 10.67 ms
            const int Preroll = 8;      // silent reports after the prime
            const int Target = 3;       // blocks waiting (~32 ms); with more, some are skipped
            const int MaxBlocks = 32;
            const int Hangover = 940;   // ~10 s of silence and the stream closes
            const byte Volume = 0x50;   // the pad's speaker volume (0-255) until the game sets one
            const int Length = 398;     // report 0x36 without the padding Windows wants

            sealed class Block
            {
                public readonly short[] Sound = new short[480 * 2]; // 512 frames as 480, for Opus
                public readonly byte[] Haptics = new byte[64];       // 32 frames, 3 kHz, 8-bit stereo
                public bool Silent;
            }

            static readonly Block Quiet = new Block { Silent = true };
            static readonly double Period = System.Diagnostics.Stopwatch.Frequency * (double)Frames / 48000;

            [DllImport("winmm.dll")] static extern int timeBeginPeriod(int ms);
            [DllImport("winmm.dll")] static extern int timeEndPeriod(int ms);

            readonly PadWriter writer;
            readonly OpusFrameEncoder opus;
            readonly bool vibrationV2;
            readonly object gate = new object();
            readonly Queue<Block> blocks = new Queue<Block>();
            readonly AutoResetEvent wake = new AutoResetEvent(false);
            readonly short[] frames = new short[Frames * 4];
            readonly byte[] report;
            int filled;
            byte[] pcm = new byte[0];
            volatile bool open, stop;
            byte seq, counter;
            byte rumbleSmall, rumbleLarge;
            double magSmall, magLarge, phaseSmall, phaseLarge;
            public int Opened, Skipped, Errors; // status, for diagnostics
            string error;
            // The game's audio settings (-1: not set yet): headphone and speaker volume, audio control (output path), audio control 2 (preamp).
            volatile int gameHeadphones = -1, gameVolume = -1, gameControl = -1, gameControl2 = -1;
            string loggedSettings;
            // Diagnostics: the loudest front (speaker) and rear (haptics) sample of the last second.
            int peakFront, peakRear, transfers, peakAt = Environment.TickCount;
            readonly System.Collections.Concurrent.ConcurrentQueue<string> log = new System.Collections.Concurrent.ConcurrentQueue<string>();

            public BluetoothSpeaker(PadWriter writer, OpusFrameEncoder opus, bool vibrationV2)
            {
                this.writer = writer;
                this.opus = opus;
                this.vibrationV2 = vibrationV2;
                report = new byte[Math.Max(writer.Length, Length)];
                new Thread(Run) { IsBackground = true, Name = "pad-speaker", Priority = ThreadPriority.AboveNormal }.Start();
            }

            public string Describe()
            {
                return "bluetooth speaker " + (open ? "playing" : "idle") + ", opened " + Opened + ", skipped " + Skipped
                    + (error != null ? ", error: " + error : "");
            }

            /// <summary>An output state the game sent (on libVIIPER's thread): its audio settings are kept.</summary>
            public void Observe(byte[] p)
            {
                if ((p[0] & 0x10) != 0) gameHeadphones = p[4];
                if ((p[0] & 0x20) != 0) gameVolume = p[5];
                if ((p[0] & 0x80) != 0) gameControl = p[7];
                if ((p[1] & 0x80) != 0) gameControl2 = p[37];
                var now = string.Format("game audio: speaker volume {0}, headphone volume {1}, audio control {2}, audio control 2 {3}",
                    Hex(gameVolume), Hex(gameHeadphones), Hex(gameControl), Hex(gameControl2));
                if (now != loggedSettings)
                {
                    loggedSettings = now;
                    Log(now);
                }
            }

            static string Hex(int v) { return v < 0 ? "unset" : "0x" + v.ToString("X2"); }

            void Log(string line) { log.Enqueue(DateTime.Now.ToString("HH:mm:ss.fff") + " " + line); }

            /// <summary>Writes what was logged (on this stream's thread, never libVIIPER's).</summary>
            void FlushLog()
            {
                if (log.IsEmpty) return;
                try
                {
                    var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PS5 Game Launcher");
                    var file = Path.Combine(dir, "speaker.log");
                    Directory.CreateDirectory(dir);
                    var info = new FileInfo(file);
                    if (info.Exists && info.Length > 256 * 1024) info.Delete();
                    var text = new StringBuilder();
                    string line;
                    while (log.TryDequeue(out line)) text.Append(line).Append(Environment.NewLine);
                    File.AppendAllText(file, text.ToString());
                }
                catch { }
            }

            /// <summary>Called on libVIIPER's thread with the PCM of one USB transfer.</summary>
            public void Push(IntPtr data, int length)
            {
                lock (gate)
                {
                    if (pcm.Length < length) pcm = new byte[length];
                    Marshal.Copy(data, pcm, 0, length);
                    transfers++;
                    for (int i = 0; i + 7 < length; i += 8)
                    {
                        for (int c = 0; c < 4; c++) frames[filled * 4 + c] = (short)(pcm[i + c * 2] | pcm[i + c * 2 + 1] << 8);
                        peakFront = Math.Max(peakFront, Math.Max(Math.Abs((int)frames[filled * 4]), Math.Abs((int)frames[filled * 4 + 1])));
                        peakRear = Math.Max(peakRear, Math.Max(Math.Abs((int)frames[filled * 4 + 2]), Math.Abs((int)frames[filled * 4 + 3])));
                        if (++filled < Frames) continue;
                        filled = 0;
                        var b = MakeBlock();
                        if (b == null) continue; // nothing to play: the pad stays as it is
                        blocks.Enqueue(b);
                        while (blocks.Count > MaxBlocks)
                        {
                            blocks.Dequeue();
                            Skipped++;
                        }
                        wake.Set();
                    }
                    if (Environment.TickCount - peakAt >= 1000)
                    {
                        // Once a second while the game streams: only when there was sound, or a stream is open.
                        if (peakFront > 16 || open)
                            Log(string.Format("audio from the game: {0} transfers of {1} bytes, loudest speaker sample {2}, loudest haptics sample {3}{4}",
                                transfers, length, peakFront, peakRear, open ? " (stream open)" : ""));
                        peakFront = peakRear = transfers = 0;
                        peakAt = Environment.TickCount;
                    }
                }
            }

            /// <summary>The game opened, closed or reset the audio stream: start over.</summary>
            public void Reset()
            {
                lock (gate)
                {
                    filled = 0;
                    blocks.Clear();
                }
                Log("the game reset its audio stream");
            }

            /// <summary>The 512 frames gathered, for a report; null when silent and no stream is open.</summary>
            Block MakeBlock()
            {
                int peak = 0;
                for (int f = 0; f < Frames; f++)
                {
                    peak = Math.Max(peak, Math.Abs((int)frames[f * 4]));
                    peak = Math.Max(peak, Math.Abs((int)frames[f * 4 + 1]));
                }
                if (peak <= 16 && !open) return null;
                var b = new Block { Silent = peak <= 16 };
                // The pad plays one 480-sample Opus frame per report: 512 frames into 480 (linear).
                const double step = (Frames - 1) / 479.0;
                for (int i = 0; i < 480; i++)
                {
                    double x = i * step;
                    int k = (int)x, k2 = Math.Min(k + 1, Frames - 1);
                    double t = x - k;
                    for (int c = 0; c < 2; c++)
                        b.Sound[i * 2 + c] = (short)(frames[k * 4 + c] + (frames[k2 * 4 + c] - frames[k * 4 + c]) * t);
                }
                // The haptics, as BluetoothHaptics makes them: 16 frames averaged into one, 8-bit.
                for (int i = 0; i < 32; i++)
                {
                    int l = 0, r = 0;
                    for (int f = i * 16; f < i * 16 + 16; f++)
                    {
                        l += frames[f * 4 + 2];
                        r += frames[f * 4 + 3];
                    }
                    b.Haptics[i * 2] = (byte)(sbyte)(l / 16 >> 8);
                    b.Haptics[i * 2 + 1] = (byte)(sbyte)(r / 16 >> 8);
                }
                return b;
            }

            void Run()
            {
                while (!stop)
                {
                    FlushLog();
                    bool any;
                    lock (gate) any = blocks.Count > 0;
                    if (!any)
                    {
                        wake.WaitOne(200);
                        continue;
                    }
                    timeBeginPeriod(1);
                    try
                    {
                        Stream();
                    }
                    catch (Exception e)
                    {
                        Errors++;
                        error = e.Message;
                    }
                    finally
                    {
                        timeEndPeriod(1);
                        Close();
                        Log("stream closed (blocks skipped so far: " + Skipped + (error != null ? ", error: " + error : "") + ")");
                    }
                }
            }

            /// <summary>One stream: prime, warm up, then a report every 10.67 ms until it has been quiet a while.</summary>
            void Stream()
            {
                Prime();
                double due = System.Diagnostics.Stopwatch.GetTimestamp();
                for (int i = 0; i < Preroll && !stop; i++)
                {
                    Send(Quiet);
                    due += Period;
                    WaitUntil(due);
                }
                int quiet = 0, tick = 0, sent = 0;
                while (!stop)
                {
                    Block b = null;
                    lock (gate)
                    {
                        if (blocks.Count > 0) b = blocks.Dequeue();
                        // Behind (after the prime, or a hiccup): skip silence, else a block now and then.
                        while (blocks.Count > Target && blocks.Peek().Silent)
                        {
                            blocks.Dequeue();
                            Skipped++;
                        }
                        if (blocks.Count > Target + 1 && ++tick % 8 == 0)
                        {
                            blocks.Dequeue();
                            Skipped++;
                        }
                    }
                    if (b == null) b = Quiet;
                    if (++sent % 94 == 0) FlushLog();
                    quiet = b.Silent ? quiet + 1 : 0;
                    if (quiet > Hangover) return;
                    Send(b);
                    // Paced against the clock, not the last report; late, it starts over from now (no burst).
                    due = Math.Max(due + Period, System.Diagnostics.Stopwatch.GetTimestamp());
                    WaitUntil(due);
                }
            }

            static void WaitUntil(double due)
            {
                while (true)
                {
                    var left = (due - System.Diagnostics.Stopwatch.GetTimestamp()) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
                    if (left <= 0.3) return;
                    Thread.Sleep(left > 2 ? (int)left - 1 : 1);
                }
            }

            void Prime()
            {
                open = true;
                writer.Hold(true);
                seq = counter = 0;
                opus.Reset();
                magSmall = magLarge = 0;
                var s = State();
                // The speaker path and volume, then report 0x32 opens the stream (with the same state).
                writer.Write(writer.StateReport(s));
                var r = new byte[Math.Max(writer.Length, 142)];
                r[0] = 0x32;
                r[1] = 0x10;
                r[2] = 0x90; r[3] = 0x3F; // packet 0x10 (sized, 63 bytes): output state
                Array.Copy(s, 0, r, 4, s.Length);
                PutCrc(r, 138);
                writer.Write(r);
                Opened++;
                Log(string.Format("stream opened: speaker volume 0x{0:X2}, audio control 0x{1:X2}, audio control 2 0x{2:X2}, route 0x{3:X2}{4}",
                    s[5], s[7], s[37], Route(), gameControl < 0 ? " (defaults: the game set no path)" : ""));
            }

            /// <summary>The Opus lane: the headset's when the path is headphones only, else the speaker's.</summary>
            byte Route()
            {
                var control = gameControl >= 0 ? gameControl : 0x30;
                return (byte)((control & 0x30) == 0 ? 0x96 : 0x93);
            }

            void Close()
            {
                open = false;
                lock (gate) blocks.Clear();
                // Rumble that is still on goes back to the motors.
                if (rumbleSmall != 0 || rumbleLarge != 0)
                {
                    var p = new byte[47];
                    p[0] = 0x02;
                    if (vibrationV2) p[38] = 0x04;
                    else p[0] |= 0x01;
                    p[2] = rumbleSmall;
                    p[3] = rumbleLarge;
                    writer.Post(p);
                }
                writer.Hold(false);
            }

            /// <summary>The game's output state waiting (if any), with the speaker's audio settings.</summary>
            byte[] State()
            {
                var p = writer.TakeState() ?? new byte[47];
                // The pad ignores its motors now: rumble is played on the haptics (Mix).
                if ((p[0] & 0x03) != 0 || (p[38] & 0x04) != 0)
                {
                    rumbleSmall = p[2];
                    rumbleLarge = p[3];
                }
                p[0] &= 0xFC;
                p[38] &= 0xFB;
                p[2] = p[3] = 0;
                p[0] |= 0x10 | 0x20 | 0x80; // headphone volume, speaker volume, audio control
                p[1] |= 0x80;               // audio control 2
                // The game's own settings (a wired pad gets them from it), else: the speaker, at Volume.
                p[4] = (byte)(gameHeadphones >= 0 ? gameHeadphones : 0x3F);
                p[5] = (byte)(gameVolume >= 0 ? gameVolume : Volume);
                p[7] = (byte)(gameControl >= 0 ? gameControl : 0x30);
                p[37] = (byte)(gameControl2 >= 0 ? gameControl2 : 0x02);
                return p;
            }

            void Send(Block b)
            {
                var r = report;
                r[0] = 0x36;
                r[1] = (byte)(seq << 4);
                seq = (byte)((seq + 1) & 0x0F);
                r[2] = 0x91; r[3] = 0x07; // packet 0x11 (sized, 7 bytes): mic off, buffer lengths
                r[4] = 0xFE;
                r[5] = r[6] = r[7] = r[8] = r[9] = 0x40;
                r[10] = counter++;
                r[11] = 0x90; r[12] = 0x3F; // packet 0x10 (sized, 63 bytes): output state
                Array.Copy(State(), 0, r, 13, 47);
                r[76] = 0x92; r[77] = 0x40; // packet 0x12 (sized, 64 bytes): haptics
                Array.Copy(b.Haptics, 0, r, 78, 64);
                Mix(r, 78);
                r[142] = Route(); r[143] = OpusFrameEncoder.Bytes; // packet 0x13 / 0x16 (sized): the speaker's / headset's Opus frame
                // The speaker plays the right channel only (path 0x30): without the game's own path, both sides go to it.
                if (gameControl < 0 && !b.Silent) Mono(b.Sound);
                if (!opus.Encode(b.Sound, r, 144)) throw new InvalidOperationException("Opus frame of the wrong size");
                PutCrc(r, Length - 4);
                writer.Write(r);
            }

            static void Mono(short[] sound)
            {
                for (int i = 0; i + 1 < sound.Length; i += 2)
                {
                    var m = (short)((sound[i] + sound[i + 1]) / 2);
                    sound[i] = sound[i + 1] = m;
                }
            }

            /// <summary>
            /// The game's rumble on the haptics, as DualSense Client plays it: the strong
            /// motor as 60 Hz, the weak one as 180 Hz, eased over about 50 ms.
            /// </summary>
            void Mix(byte[] r, int at)
            {
                const double rate = 3000;
                double ease = 1 - Math.Exp(-1 / (0.05 * rate));
                for (int i = 0; i < 32; i++)
                {
                    magLarge += (rumbleLarge / 255.0 - magLarge) * ease;
                    magSmall += (rumbleSmall / 255.0 - magSmall) * ease;
                    phaseLarge = (phaseLarge + 60 / rate) % 1;
                    phaseSmall = (phaseSmall + 180 / rate) % 1;
                    if (magLarge < 0.002 && magSmall < 0.002) continue;
                    int w = (int)Math.Round((magLarge * Math.Sin(2 * Math.PI * phaseLarge) + magSmall * Math.Sin(2 * Math.PI * phaseSmall)) * 127);
                    for (int c = 0; c < 2; c++)
                    {
                        int v = (sbyte)r[at + i * 2 + c] + w;
                        r[at + i * 2 + c] = (byte)(sbyte)Math.Max(-128, Math.Min(127, v));
                    }
                }
            }

            public void Dispose()
            {
                stop = true;
                wake.Set();
            }
        }

        /* ---------------- Control ---------------- */

        static void Notify()
        {
            Program.Emit(new Dictionary<string, object> { { "event", "passthrough" }, { "state", Status() } });
        }

        public static object Status()
        {
            lock (Gate)
            {
                return new Dictionary<string, object>
                {
                    { "enabled", Enabled },
                    { "muted", Muted },
                    { "hidhide", hidhide },
                    { "viiper", viiper },
                    { "devices", Pads.Count + XboxPads.Count },
                    { "xbox", XboxPads.Count },
                    { "emulation", emulation },
                    { "allowed", allowed.ToArray() },
                    { "inverse", inverse },
                    { "error", lastError },
                    { "library", LibVersion() },
                    { "pads", Pads.Values.Select(p => new Dictionary<string, object>
                        {
                            { "kind", p.Kind }, { "bluetooth", p.Bluetooth }, { "gameOutputs", p.GameOutputs },
                            { "states", p.Out.States }, { "haptics", p.Out.Haptics }, { "speaker", p.Out.Speaker }, { "failed", p.Out.Failed },
                            { "sound", p.Sound != null ? p.Sound.Describe() : p.Speaker != null ? p.Speaker.Describe() : p.Bluetooth && IsDualSense(p) ? speakerError : null },
                        }).ToArray() },
                };
            }
        }

        /// <summary>Change what the DualSense is shown as; live virtual pads are rebuilt.</summary>
        public static object Configure(string mode)
        {
            if (mode != "dualsense" && mode != "dualshock4" && mode != "xbox360") mode = "dualsense";
            if (mode == emulation) return Status();
            emulation = mode;
            if (!Enabled) return Status();
            lock (Change)
            {
                List<Virtual> rebuild;
                lock (Gate)
                {
                    rebuild = Pads.Values.ToList();
                    Pads.Clear();
                }
                foreach (var v in rebuild) Destroy(v);
            }
            foreach (var p in Pad.PlayStationPaths()) OnConnected(p.Key, p.Value);
            Notify();
            return Status();
        }

        public static object Enable(bool on)
        {
            if (!on && !Enabled)
            {
                RemoveRecorded(); // left over from a run that didn't shut down cleanly
                return Status();
            }
            if (on && shuttingDown) return Status();
            lock (Change)
            {
                if (on == Enabled) return Status();
                if (on)
                {
                    lastError = null;
                    if (!SetupHidHide() || !SetupViiper())
                    {
                        UnhideAll();
                        return Status();
                    }
                    Enabled = true;
                }
                else Disable();
            }
            if (on)
            {
                HideXboxDevices();
                foreach (var p in Pad.PlayStationPaths()) OnConnected(p.Key, p.Value);
            }
            Notify();
            return Status();
        }

        public static void Disable()
        {
            lock (Change)
            {
                Enabled = false;
                List<Virtual> all;
                lock (Gate)
                {
                    all = Pads.Values.ToList();
                    Pads.Clear();
                }
                foreach (var v in all) Destroy(v);
                foreach (var v in TakeXbox()) Destroy(v);
                if (busId >= 0)
                {
                    try { Lib.RemoveUSBBus(server, (uint)busId); } catch { }
                    busId = -1;
                }
            }
            UnhideAll();
        }

        /// <summary>The helper is exiting: off for good (a request still on its way can't turn it back on).</summary>
        public static void ShutDown()
        {
            shuttingDown = true;
            Disable();
        }

        public static object SetMuted(bool m)
        {
            Muted = m;
            List<Virtual> all;
            lock (Gate) all = Pads.Values.Concat(XboxPads.Values).ToList();
            foreach (var v in all)
            {
                if (v.XSlot >= 0) v.XMuted = m;
                Push(v);
            }
            return true;
        }
    }

    // A virtual DualSense has a wired one's audio device: games play its HD
    // haptics (channels 3-4) and speaker (1-2) on it, 4 channels, 16-bit, 48 kHz.
    // A controller on USB gets that on its own audio device.

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint frames);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioRenderClient
    {
        int GetBuffer(uint frames, out IntPtr data);
        int ReleaseBuffer(uint frames, uint flags);
    }

    /// <summary>Audio endpoints: the one of a given device, the defaults, and keeping the defaults.</summary>
    static class Endpoints
    {
        [StructLayout(LayoutKind.Sequential)]
        struct DEVPROPKEY { public Guid fmtid; public uint pid; }

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Locate_DevNode(out uint node, string id, int flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_DevNode_PropertyW(uint node, ref DEVPROPKEY key, out uint type, byte[] buf, ref int size, int flags);
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);

        static readonly Guid ContainerKey = new Guid("8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c"); // DEVPKEY/PKEY_Device_ContainerId, 2
        static readonly Guid NameKey = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");      // PKEY_Device_FriendlyName, 14

        /// <summary>The container (physical device) a HID device belongs to.</summary>
        static Guid? ContainerOf(string hidPath)
        {
            uint node;
            if (CM_Locate_DevNode(out node, Pad.InstancePath(hidPath), 0) != 0) return null;
            var key = new DEVPROPKEY { fmtid = ContainerKey, pid = 2 };
            var buf = new byte[16];
            var size = buf.Length;
            uint type;
            if (CM_Get_DevNode_PropertyW(node, ref key, out type, buf, ref size, 0) != 0 || size != 16) return null;
            return new Guid(buf);
        }

        static IPropertyStore Store(IMMDevice d)
        {
            IntPtr ps;
            if (d.OpenPropertyStore(0, out ps) != 0 || ps == IntPtr.Zero) return null;
            return (IPropertyStore)Marshal.GetObjectForIUnknown(ps);
        }

        public static string Name(IMMDevice d)
        {
            var store = Store(d);
            if (store == null) return "";
            var key = new PROPERTYKEY { fmtid = NameKey, pid = 14 };
            PROPVARIANT v;
            if (store.GetValue(ref key, out v) != 0) return "";
            try { return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : ""; }
            finally { PropVariantClear(ref v); }
        }

        static Guid? Container(IMMDevice d)
        {
            var store = Store(d);
            if (store == null) return null;
            var key = new PROPERTYKEY { fmtid = ContainerKey, pid = 2 };
            PROPVARIANT v;
            if (store.GetValue(ref key, out v) != 0) return null;
            try { return v.vt == 72 /* VT_CLSID */ && v.p != IntPtr.Zero ? (Guid?)(Guid)Marshal.PtrToStructure(v.p, typeof(Guid)) : null; }
            finally { PropVariantClear(ref v); }
        }

        /// <summary>The playback endpoint of the physical device a HID device path belongs to.</summary>
        public static string ForDevice(string hidPath)
        {
            var container = ContainerOf(hidPath);
            if (container == null) return null;
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(0 /* render */, 1 /* active */, out col) != 0) return null;
            uint count;
            col.GetCount(out count);
            for (uint i = 0; i < count; i++)
            {
                IMMDevice d;
                if (col.Item(i, out d) != 0) continue;
                if (Container(d) != container) continue;
                string id;
                d.GetId(out id);
                return id;
            }
            return null;
        }

        /// <summary>Default playback endpoint per role (console, multimedia, communications).</summary>
        public static string[] Defaults()
        {
            var ids = new string[3];
            var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            for (int role = 0; role < 3; role++)
            {
                IMMDevice d;
                if (en.GetDefaultAudioEndpoint(0, role, out d) == 0) d.GetId(out ids[role]);
            }
            return ids;
        }

        /// <summary>
        /// Windows makes a newly connected audio device the default playback device,
        /// so the virtual DualSense's speaker would take all of the PC's sound. For a
        /// while after one appears, put the previous defaults back.
        /// </summary>
        public static void KeepDefaults(string[] before)
        {
            if (before == null) return;
            new Thread(() =>
            {
                var until = Environment.TickCount + 15000;
                while (Environment.TickCount - until < 0)
                {
                    Thread.Sleep(200);
                    try
                    {
                        var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                        for (int role = 0; role < 3; role++)
                        {
                            IMMDevice d;
                            string id;
                            if (before[role] == null || en.GetDefaultAudioEndpoint(0, role, out d) != 0) continue;
                            d.GetId(out id);
                            if (id == before[role] || Name(d).IndexOf("DualSense", StringComparison.OrdinalIgnoreCase) < 0) continue;
                            ((IPolicyConfig)new PolicyConfigClient()).SetDefaultEndpoint(before[role], role);
                        }
                    }
                    catch { }
                }
            }) { IsBackground = true, Name = "keep-default-output" }.Start();
        }
    }

    /// <summary>
    /// Opus frames for a DualSense's speaker over Bluetooth, as the pad takes them
    /// (DualSense Client's settings): 48 kHz stereo, 10 ms (480 samples), a constant
    /// 160 kbit/s, so always 200 bytes. The encoder is Concentus (a C# port of
    /// libopus, Concentus.dll next to this helper: scripts/fetch-concentus.js); it is
    /// only built in when that DLL was there, and without it there's no speaker.
    /// </summary>
    sealed class OpusFrameEncoder
    {
        public const int Bytes = 200;
#if OPUS
        Concentus.Structs.OpusEncoder encoder;

        public OpusFrameEncoder() { Reset(); }

        /// <summary>A fresh encoder: the pad's decoder starts fresh with every stream.</summary>
        public void Reset()
        {
            var e = Concentus.Structs.OpusEncoder.Create(48000, 2, Concentus.Enums.OpusApplication.OPUS_APPLICATION_AUDIO);
            e.ExpertFrameDuration = Concentus.Enums.OpusFramesize.OPUS_FRAMESIZE_10_MS;
            e.Bitrate = Bytes * 8 * 100;
            e.UseVBR = false;
            e.Complexity = 0;
            encoder = e;
        }

        /// <summary>480 stereo frames into dst[at..at + 200).</summary>
        public bool Encode(short[] pcm, byte[] dst, int at)
        {
            return encoder.Encode(pcm, 0, 480, dst, at, Bytes) == Bytes;
        }
#else
        public OpusFrameEncoder() { throw new NotSupportedException("built without Concentus.dll (scripts/fetch-concentus.js)"); }
        public void Reset() { }
        public bool Encode(short[] pcm, byte[] dst, int at) { return false; }
#endif
    }

    /// <summary>Plays the game's controller audio on a wired DualSense's own audio device.</summary>
    sealed class WiredOutput : IDisposable
    {
        const int FrameBytes = 8;                       // 4 channels x 16 bit
        const int MaxQueued = 48000 * FrameBytes / 16;  // 62.5 ms: beyond that (clock drift), drop the oldest
        readonly string endpoint;
        readonly byte[] ring = new byte[48000 * FrameBytes / 4];
        int head, fill;
        readonly object gate = new object();
        volatile bool stop;
        string state = "starting";

        public WiredOutput(string endpointId)
        {
            endpoint = endpointId;
            new Thread(Run) { IsBackground = true, Name = "pad-audio", Priority = ThreadPriority.AboveNormal }.Start();
        }

        public string Describe() { return "wired audio " + state; }

        byte[] pcm = new byte[0];

        /// <summary>Called on libVIIPER's thread with the PCM of one USB transfer.</summary>
        public void Push(IntPtr data, int count)
        {
            lock (gate)
            {
                if (pcm.Length < count) pcm = new byte[count];
                Marshal.Copy(data, pcm, 0, count);
                for (int i = 0; i < count; i++)
                {
                    ring[(head + fill) % ring.Length] = pcm[i];
                    if (fill < ring.Length) fill++;
                    else head = (head + 1) % ring.Length;
                }
                if (fill > MaxQueued)
                {
                    var drop = (fill - MaxQueued) / FrameBytes * FrameBytes;
                    head = (head + drop) % ring.Length;
                    fill -= drop;
                }
            }
        }

        int Take(byte[] dst, int max)
        {
            lock (gate)
            {
                var n = Math.Min(max, fill) / FrameBytes * FrameBytes;
                for (int i = 0; i < n; i++) dst[i] = ring[(head + i) % ring.Length];
                head = (head + n) % ring.Length;
                fill -= n;
                return n;
            }
        }

        static IntPtr Format()
        {
            // WAVEFORMATEXTENSIBLE: 4 channels (FL FR BL BR), 16-bit PCM, 48 kHz.
            var b = new byte[40];
            BitConverter.GetBytes((ushort)0xFFFE).CopyTo(b, 0);
            BitConverter.GetBytes((ushort)4).CopyTo(b, 2);
            BitConverter.GetBytes(48000).CopyTo(b, 4);
            BitConverter.GetBytes(48000 * FrameBytes).CopyTo(b, 8);
            BitConverter.GetBytes((ushort)FrameBytes).CopyTo(b, 12);
            BitConverter.GetBytes((ushort)16).CopyTo(b, 14);
            BitConverter.GetBytes((ushort)22).CopyTo(b, 16);
            BitConverter.GetBytes((ushort)16).CopyTo(b, 18);
            BitConverter.GetBytes(0x33).CopyTo(b, 20);
            new Guid("00000001-0000-0010-8000-00aa00389b71").ToByteArray().CopyTo(b, 24);
            var p = Marshal.AllocHGlobal(b.Length);
            Marshal.Copy(b, 0, p, b.Length);
            return p;
        }

        void Run()
        {
            IAudioClient client = null;
            var fmt = Format();
            try
            {
                var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                IMMDevice dev;
                Marshal.ThrowExceptionForHR(en.GetDevice(endpoint, out dev));
                var iid = typeof(IAudioClient).GUID;
                object o;
                Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
                client = (IAudioClient)o;
                using (var wake = new AutoResetEvent(false))
                {
                    // Shared mode, woken every device period; Windows converts to the device's mix format.
                    Marshal.ThrowExceptionForHR(client.Initialize(0, 0x00040000 | 0x80000000 | 0x08000000, 300000, 0, fmt, IntPtr.Zero));
                    Marshal.ThrowExceptionForHR(client.SetEventHandle(wake.SafeWaitHandle.DangerousGetHandle()));
                    uint size;
                    client.GetBufferSize(out size);
                    var riid = typeof(IAudioRenderClient).GUID;
                    object ro;
                    Marshal.ThrowExceptionForHR(client.GetService(ref riid, out ro));
                    var render = (IAudioRenderClient)ro;
                    var chunk = new byte[size * FrameBytes];
                    Marshal.ThrowExceptionForHR(client.Start());
                    state = "playing";
                    while (!stop)
                    {
                        wake.WaitOne(100);
                        uint pad;
                        if (client.GetCurrentPadding(out pad) != 0) break;
                        var n = Take(chunk, (int)(size - pad) * FrameBytes);
                        if (n == 0) continue; // nothing new: the device plays silence
                        IntPtr p;
                        if (render.GetBuffer((uint)(n / FrameBytes), out p) != 0) continue;
                        Marshal.Copy(chunk, 0, p, n);
                        render.ReleaseBuffer((uint)(n / FrameBytes), 0);
                    }
                    client.Stop();
                }
                state = "stopped";
            }
            catch (Exception e)
            {
                state = "failed: " + e.Message;
            }
            finally
            {
                Marshal.FreeHGlobal(fmt);
                if (client != null) Marshal.ReleaseComObject(client);
            }
        }

        public void Dispose() { stop = true; }
    }

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

        // The kind of controller pressed last ("ps" for PlayStation pads read over HID), for button prompts.
        static string lastKind = "xbox";

        static void Emit(string evt, string action, bool repeat)
        {
            var d = new Dictionary<string, object> { { "event", evt }, { "kind", lastKind } };
            if (action != null) d["action"] = action;
            if (repeat) d["repeat"] = true;
            Program.Emit(d);
        }

        public static void Update(string src, int mask)
        {
            lock (Gate)
            {
                int prev;
                // A DualSense sends hundreds of reports a second; nearly all repeat the same buttons.
                if (Prev.TryGetValue(src, out prev) && prev == mask) return;
                Prev[src] = mask;
                var pressed = mask & ~prev;
                if (pressed != 0) lastKind = src.StartsWith("h") ? "ps" : "xbox";
                for (var i = 0; i < Bits.Length; i++)
                {
                    var bit = Bits[i];
                    var key = src + ":" + bit;
                    if ((pressed & bit) != 0)
                    {
                        if (bit == GUIDE) Emit("guide", null, false);
                        else
                        {
                            // Create button of a PlayStation controller: the capture menu.
                            if (bit == SELECT && src.StartsWith("h")) Emit("share", null, false);
                            if (Forward) Emit("pad", Names[i], false);
                        }
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

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_VIBRATION { public ushort wLeftMotorSpeed; public ushort wRightMotorSpeed; }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate uint XInputSetStateFn(uint user, ref XINPUT_VIBRATION vibration);

        // XInputGetCapabilitiesEx (ordinal 108): the capabilities plus the controller's USB ids.
        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_CAPABILITIES_EX
        {
            public byte Type, SubType;
            public ushort Flags;
            public XINPUT_GAMEPAD Gamepad;
            public XINPUT_VIBRATION Vibration;
            public ushort VendorId, ProductId, ProductVersion, Unknown1;
            public uint Unknown2;
        }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate uint XInputGetCapabilitiesExFn(uint one, uint user, uint flags, out XINPUT_CAPABILITIES_EX caps);

        static XInputSetStateFn xinputSet;
        static XInputGetCapabilitiesExFn xinputCaps;

        /// <summary>Rumble on a real XInput controller (a game's rumble for its virtual pad).</summary>
        public static void XInputRumble(int slot, byte left, byte right)
        {
            if (xinputSet == null) return;
            var v = new XINPUT_VIBRATION { wLeftMotorSpeed = (ushort)(left * 257), wRightMotorSpeed = (ushort)(right * 257) };
            try { xinputSet((uint)slot, ref v); } catch { }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct HIDD_ATTRIBUTES { public int Size; public ushort VendorID, ProductID, VersionNumber; }
        [DllImport("hid.dll")] static extern bool HidD_GetAttributes(Microsoft.Win32.SafeHandles.SafeFileHandle h, ref HIDD_ATTRIBUTES a);
        [DllImport("hid.dll", CharSet = CharSet.Unicode)] static extern bool HidD_GetProductString(Microsoft.Win32.SafeHandles.SafeFileHandle h, StringBuilder buf, int len);

        /// <summary>A HID device's ids and product name (null if it can't be opened).</summary>
        static Dictionary<string, object> HidIds(string path)
        {
            using (var h = CreateFile(path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero))
            {
                if (h.IsInvalid) return null;
                var a = new HIDD_ATTRIBUTES { Size = Marshal.SizeOf(typeof(HIDD_ATTRIBUTES)) };
                if (!HidD_GetAttributes(h, ref a)) return null;
                var name = new StringBuilder(128);
                HidD_GetProductString(h, name, 256);
                return new Dictionary<string, object> { { "vid", (int)a.VendorID }, { "pid", (int)a.ProductID }, { "version", (int)a.VersionNumber }, { "product", name.ToString() } };
            }
        }

        /// <summary>
        /// The real controllers, with what SDL (in emulators) builds its device ids
        /// from: PlayStation pads as read over HID, the rest through XInput. The
        /// launcher's own virtual pads are left out.
        /// </summary>
        public static object Gamepads()
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var kv in PlayStationPaths())
            {
                var ids = HidIds(kv.Key);
                if (ids == null) continue;
                ids["kind"] = "ps";
                ids["path"] = kv.Key;
                ids["bus"] = kv.Key.IndexOf("{00001124", StringComparison.OrdinalIgnoreCase) >= 0 ? "bluetooth" : "usb";
                ids["mac"] = PadInfo.MacOf(kv.Key);
                list.Add(ids);
            }
            // XInput's own product names, by USB ids (a GIP Xbox pad's HID part says 045E:02FF instead).
            var names = new Dictionary<string, string>();
            foreach (var path in HidPaths())
            {
                if (path.IndexOf("&ig_", StringComparison.OrdinalIgnoreCase) < 0 || IsVirtual(path)) continue;
                var ids = HidIds(path);
                if (ids != null) names[string.Format("{0:x4}:{1:x4}", ids["vid"], ids["pid"])] = (string)ids["product"];
            }
            if (xinputCaps != null)
            {
                for (var slot = 0; slot < 4; slot++)
                {
                    if (Passthrough.IsVirtualSlot(slot)) continue;
                    XINPUT_CAPABILITIES_EX c;
                    try { if (xinputCaps(1, (uint)slot, 0, out c) != 0) continue; }
                    catch { continue; }
                    string product;
                    names.TryGetValue(string.Format("{0:x4}:{1:x4}", c.VendorId, c.ProductId), out product);
                    list.Add(new Dictionary<string, object>
                    {
                        { "kind", "xinput" }, { "slot", slot }, { "vid", (int)c.VendorId }, { "pid", (int)c.ProductId },
                        { "version", (int)c.ProductVersion }, { "subtype", (int)c.SubType }, { "product", product ?? "" },
                    });
                }
            }
            return list;
        }

        /// <summary>USB product id of the controller in an XInput slot (-1: unknown).</summary>
        public static int XInputProduct(int slot)
        {
            if (xinputCaps == null) return -1;
            try
            {
                XINPUT_CAPABILITIES_EX c;
                return xinputCaps(1, (uint)slot, 0, out c) == 0 ? c.ProductId : -1;
            }
            catch { return -1; }
        }

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_Interface_List_SizeW(out int len, ref Guid g, string dev, int flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_Interface_ListW(ref Guid g, string dev, char[] buf, int len, int flags);

        /// <summary>Paths of the present devices with an interface (e.g. XInput's XUSB one).</summary>
        public static string[] InterfacePaths(Guid g)
        {
            try
            {
                int n;
                if (CM_Get_Device_Interface_List_SizeW(out n, ref g, null, 0) != 0 || n <= 1) return new string[0];
                var b = new char[n];
                if (CM_Get_Device_Interface_ListW(ref g, null, b, n, 0) != 0) return new string[0];
                return new string(b).Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
            }
            catch { return new string[0]; }
        }

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
                    var set = GetProcAddress(lib, "XInputSetState");
                    if (set != IntPtr.Zero) xinputSet = (XInputSetStateFn)Marshal.GetDelegateForFunctionPointer(set, typeof(XInputSetStateFn));
                    var caps = GetProcAddressOrdinal(lib, (IntPtr)108);
                    if (caps != IntPtr.Zero) xinputCaps = (XInputGetCapabilitiesExFn)Marshal.GetDelegateForFunctionPointer(caps, typeof(XInputGetCapabilitiesExFn));
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
                        // Probing empty slots is slow, so only do it every 2 seconds
                        // (faster while a virtual Xbox pad of ours is about to show up).
                        if (!connected[i] && Now() - lastProbe[i] < (Passthrough.ExpectingVirtual ? 150 : 2000)) continue;
                        XINPUT_STATE st;
                        var r = get(i, out st);
                        if (r != 0)
                        {
                            if (connected[i])
                            {
                                Update("x" + i, 0);
                                Passthrough.XInputSlotGone((int)i);
                            }
                            connected[i] = false;
                            lastProbe[i] = Now();
                            continue;
                        }
                        if (!connected[i] && Passthrough.XInputSlotAppeared((int)i)) { connected[i] = true; continue; }
                        connected[i] = true;
                        // Our own virtual Xbox pads aren't menu input.
                        if (Passthrough.IsVirtualSlot((int)i)) continue;
                        // Controller passthrough: games get it through a virtual pad.
                        var gp = st.Gamepad;
                        Passthrough.OnXInput((int)i, st.dwPacketNumber, gp.wButtons, gp.bLeftTrigger, gp.bRightTrigger, gp.sThumbLX, gp.sThumbLY, gp.sThumbRX, gp.sThumbRY);
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
                // No XInput pad to read and no menu open: empty slots are only probed every 2 s anyway.
                var busy = connected[0] || connected[1] || connected[2] || connected[3] || Forward || Passthrough.ExpectingVirtual;
                // A real Xbox controller fed to a game through its virtual pad: every 4 ms (games poll ~every frame).
                Thread.Sleep(Passthrough.XboxActive ? 4 : busy ? 16 : 100);
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

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Locate_DevNode(out uint node, string id, int flags);
        [DllImport("cfgmgr32.dll")] static extern int CM_Get_Parent(out uint parent, uint node, int flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] static extern int CM_Get_Device_ID(uint node, StringBuilder buf, int len, int flags);
        static readonly Dictionary<string, bool> VirtualCache = new Dictionary<string, bool>();

        /// <summary>"\\?\hid#vid_054c&amp;pid_0ce6#3&amp;abc&amp;0&amp;0000#{guid}" -> "HID\VID_054C&amp;PID_0CE6\3&amp;ABC&amp;0&amp;0000".</summary>
        public static string InstancePath(string devicePath)
        {
            var p = devicePath;
            if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
            var cut = p.LastIndexOf("#{", StringComparison.Ordinal);
            if (cut > 0) p = p.Substring(0, cut);
            return p.Replace('#', '\\').ToUpperInvariant();
        }

        /// <summary>
        /// A controller on a software bus (VIIPER's virtual DualSense sits under the
        /// root-enumerated USBip host controller). Real controllers hang off PCI/ACPI.
        /// Without this the helper would mirror its own virtual pads, again and again.
        /// </summary>
        public static bool IsVirtual(string path)
        {
            lock (VirtualCache)
            {
                bool known;
                if (VirtualCache.TryGetValue(path, out known)) return known;
            }
            var result = false;
            uint node;
            if (CM_Locate_DevNode(out node, InstancePath(path), 0) == 0)
            {
                var sb = new StringBuilder(512);
                for (var depth = 0; depth < 16; depth++)
                {
                    uint parent;
                    if (CM_Get_Parent(out parent, node, 0) != 0) break;
                    node = parent;
                    sb.Length = 0;
                    if (CM_Get_Device_ID(node, sb, sb.Capacity, 0) != 0) break;
                    var id = sb.ToString().ToUpperInvariant();
                    // Reached real hardware (a PCI/ACPI host controller): a real controller.
                    if (id.StartsWith("PCI\\") || id.StartsWith("ACPI") || id.StartsWith("HTREE\\")) break;
                    if (id.StartsWith("ROOT\\") || id.Contains("USBIP") || id.Contains("VIIPER")) { result = true; break; }
                }
            }
            lock (VirtualCache) VirtualCache[path] = result;
            return result;
        }

        /// <summary>Length of the device's longest output report (WriteFile wants buffers that long).</summary>
        public static int OutputReportLength(Microsoft.Win32.SafeHandles.SafeFileHandle h)
        {
            IntPtr pre;
            if (!HidD_GetPreparsedData(h, out pre)) return 0;
            try
            {
                HIDP_CAPS caps;
                return HidP_GetCaps(pre, out caps) == 0x00110000 ? caps.OutputReportByteLength : 0;
            }
            finally
            {
                HidD_FreePreparsedData(pre);
            }
        }

        /// <summary>Length of the device's longest feature report (HidD_GetFeature wants buffers that long).</summary>
        public static int FeatureReportLength(Microsoft.Win32.SafeHandles.SafeFileHandle h)
        {
            IntPtr pre;
            if (!HidD_GetPreparsedData(h, out pre)) return 0;
            try
            {
                HIDP_CAPS caps;
                return HidP_GetCaps(pre, out caps) == 0x00110000 ? caps.FeatureReportByteLength : 0;
            }
            finally
            {
                HidD_FreePreparsedData(pre);
            }
        }

        /// <summary>PlayStation controllers being read right now: device path -> product id.</summary>
        public static Dictionary<string, string> PlayStationPaths()
        {
            var d = new Dictionary<string, string>();
            lock (Gate)
            {
                foreach (var p in HidOpen)
                {
                    var m = PsPad.Match(p);
                    if (m.Success) d[p] = m.Groups[1].Value.ToLowerInvariant();
                }
            }
            return d;
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
                        if (!m.Success || IsVirtual(path)) continue;
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
                try { Passthrough.HideXboxDevices(); } catch { }
                // Normally every 3 seconds; right after a controller restart, quickly.
                ScanWake.WaitOne(Environment.TickCount - fastScanUntil < 0 ? 150 : 3000);
            }
        }

        static readonly AutoResetEvent ScanWake = new AutoResetEvent(false);
        static int fastScanUntil = Environment.TickCount;

        /// <summary>Look for (re)connected controllers often for a while (after a restart).</summary>
        public static void ScanFast(int ms)
        {
            fastScanUntil = Environment.TickCount + ms;
            ScanWake.Set();
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
                    // Bluetooth: the HID-over-Bluetooth service in the path (its reports are longer, too).
                    var bt = path.IndexOf("{00001124", StringComparison.OrdinalIgnoreCase) >= 0 || len > 64;
                    PadInfo.OnConnected(path, pid, bt);
                    Passthrough.OnConnected(path, pid);
                    while (true)
                    {
                        int read;
                        if (!ReadFile(h, buf, len, out read, IntPtr.Zero) || read <= 0) break;
                        var mask = ParsePs(buf, read, pid, bt);
                        if (mask >= 0) Update(src, mask);
                        PadInfo.OnReport(path, buf, read);
                        Passthrough.OnReport(path, pid, buf, read);
                    }
                }
            }
            catch { }
            finally
            {
                Update(src, 0);
                lock (Gate) HidOpen.Remove(path);
                PadInfo.OnGone(path);
                Passthrough.OnGone(path);
            }
        }

        static int ParsePs(byte[] b, int n, string pid, bool bt)
        {
            var dualsense = pid == "0ce6" || pid == "0df2";
            int lx, ly, b0, b1, b2;
            if (dualsense)
            {
                // By report id and connection: Windows pads Bluetooth's simple report to full length.
                if (!bt && b[0] == 0x01 && n >= 64) { lx = 1; ly = 2; b0 = 8; b1 = 9; b2 = 10; }        // USB
                else if (bt && b[0] == 0x31 && n >= 12) { lx = 2; ly = 3; b0 = 9; b1 = 10; b2 = 11; }   // Bluetooth (full report)
                else if (bt && b[0] == 0x01 && n >= 8) { lx = 1; ly = 2; b0 = 5; b1 = 6; b2 = 7; }      // Bluetooth (simple report)
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
    /* DualSense info (Settings › Accessories, the quick menu's battery)   */
    /* ------------------------------------------------------------------ */

    /// <summary>
    /// What a DualSense tells about itself, as on DualSense Client's device page:
    /// battery and connection state from its input reports (status bytes 52 and
    /// 53 of the payload), how many reports a second it sends, and its firmware
    /// and MAC address from feature reports 0x20 and 0x09 (read once it connects).
    /// </summary>
    static class PadInfo
    {
        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
        [DllImport("hid.dll")] static extern bool HidD_GetFeature(Microsoft.Win32.SafeHandles.SafeFileHandle h, byte[] buf, int len);

        class Info
        {
            public string Path, Pid;
            public bool Bluetooth;
            public int Battery = -1, Status = -1; // the raw status bytes (-1: not reported yet)
            public int Count, RateStart = Environment.TickCount, Rate;
            public Dictionary<string, object> Firmware;
            public string Mac;
            public int FullAsks, LastFullAsk;
            public bool Dirty;
            public int LastEmit;
        }

        static readonly object Gate = new object();
        static readonly Dictionary<string, Info> Pads = new Dictionary<string, Info>();

        static bool IsDualSense(string pid) { return pid == "0ce6" || pid == "0df2"; }

        public static void OnConnected(string path, string pid, bool bluetooth)
        {
            if (!IsDualSense(pid)) return;
            var p = new Info { Path = path, Pid = pid, Bluetooth = bluetooth };
            lock (Gate) Pads[path] = p;
            new Thread(() =>
            {
                Thread.Sleep(500);
                ReadFeatures(p);
                Emit();
            }) { IsBackground = true, Name = "pad-info" }.Start();
            Emit();
        }

        public static void OnGone(string path)
        {
            bool had;
            lock (Gate) had = Pads.Remove(path);
            if (had) Emit();
        }

        public static void OnReport(string path, byte[] b, int n)
        {
            Info p;
            lock (Gate) Pads.TryGetValue(path, out p);
            if (p == null) return;
            int o = -1;
            if (!p.Bluetooth && b[0] == 0x01 && n >= 64) o = 1;
            else if (p.Bluetooth && b[0] == 0x31 && n >= 65) o = 2;
            else if (p.Bluetooth && b[0] == 0x01) AskFullReports(p);
            if (o > 0)
            {
                if (b[o + 52] != p.Battery) { p.Battery = b[o + 52]; p.Dirty = true; }
                if (b[o + 53] != p.Status) { p.Status = b[o + 53]; p.Dirty = true; }
            }
            p.Count++;
            var now = Environment.TickCount;
            var elapsed = now - p.RateStart;
            if (elapsed >= 2000)
            {
                var rate = (int)Math.Round(p.Count * 1000.0 / elapsed);
                if (Math.Abs(rate - p.Rate) >= Math.Max(3, p.Rate / 20)) p.Dirty = true;
                p.Rate = rate;
                p.Count = 0;
                p.RateStart = now;
            }
            // At most one update a second (the battery byte can flicker between two levels).
            if (p.Dirty && now - p.LastEmit >= 1000)
            {
                p.Dirty = false;
                p.LastEmit = now;
                Emit();
            }
        }

        /// <summary>
        /// A DualSense on Bluetooth sends short reports (no battery, motion or
        /// touchpad) until its calibration report (0x05) is read, as Steam and
        /// games do. Tried a few times, a second apart.
        /// </summary>
        static void AskFullReports(Info p)
        {
            if (p.FullAsks >= 3 || Environment.TickCount - p.LastFullAsk < 1000) return;
            p.FullAsks++;
            p.LastFullAsk = Environment.TickCount;
            ThreadPool.QueueUserWorkItem(_ => Feature(p.Path, 0x05));
        }

        static byte[] Feature(string path, byte id)
        {
            try
            {
                using (var h = CreateFile(path, 0x80000000 | 0x40000000, 0x1 | 0x2, IntPtr.Zero, 3, 0, IntPtr.Zero))
                {
                    if (h.IsInvalid) return null;
                    // Windows wants a buffer as long as the device's longest feature report.
                    var b = new byte[Math.Max(Pad.FeatureReportLength(h), 64)];
                    b[0] = id;
                    return HidD_GetFeature(h, b, b.Length) && b[0] == id ? b : null;
                }
            }
            catch { return null; }
        }

        static uint U32(byte[] b, int at) { return (uint)(b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24); }
        static string Version(uint v) { return string.Format("{0}.{1}.{2}", (v >> 24) & 0xFF, (v >> 16) & 0xFF, v & 0xFFFF); }
        static string Ascii(byte[] b, int at, int max)
        {
            int n = 0;
            while (n < max && b[at + n] != 0) n++;
            return Encoding.ASCII.GetString(b, at, n).Trim();
        }

        /// <summary>Firmware (0x20) and pairing (0x09) reports, the same fields DualSense Client shows.</summary>
        static void ReadFeatures(Info p)
        {
            var fw = Feature(p.Path, 0x20);
            if (fw != null)
            {
                var hw = U32(fw, 24);
                var update = fw[44] | fw[45] << 8;
                var dsp = U32(fw, 52);
                p.Firmware = new Dictionary<string, object>
                {
                    { "buildDate", Ascii(fw, 1, 11) },
                    { "buildTime", Ascii(fw, 12, 8) },
                    { "version", Version(U32(fw, 28)) },
                    { "update", string.Format("{0:X}.{1:X2}", (update >> 8) & 0xFF, update & 0xFF) },
                    { "sbl", Version(U32(fw, 48)) },
                    { "dsp", string.Format("{0:X4}_{1:X4}", (dsp >> 16) & 0xFFFF, dsp & 0xFFFF) },
                    { "mcu", Version(U32(fw, 56)) },
                    { "generation", (int)((hw >> 8) & 0xFF) },
                    { "revision", string.Format("{0:X4}", hw & 0xFFFF) },
                };
            }
            var pair = Feature(p.Path, 0x09);
            if (pair != null)
                p.Mac = string.Join(":", Enumerable.Range(1, 6).Reverse().Select(i => pair[i].ToString("X2")));
        }

        /// <summary>A DualSense's Bluetooth address (null until read).</summary>
        public static string MacOf(string path)
        {
            Info p;
            lock (Gate) Pads.TryGetValue(path, out p);
            return p != null ? p.Mac : null;
        }

        public static object List(bool refresh)
        {
            List<Info> all;
            lock (Gate) all = Pads.Values.ToList();
            if (refresh) foreach (var p in all) ReadFeatures(p);
            return all.Select(p =>
            {
                var d = new Dictionary<string, object>
                {
                    { "path", p.Path },
                    { "model", p.Pid == "0df2" ? "edge" : "dualsense" },
                    { "connection", p.Bluetooth ? "bluetooth" : "usb" },
                    { "rate", p.Rate },
                    { "mac", p.Mac },
                    { "firmware", p.Firmware },
                };
                if (p.Battery >= 0)
                {
                    int level = p.Battery & 0x0F, power = p.Battery >> 4;
                    // As DualSense Client reads the level nibble (0-10).
                    int? percent = level > 10 ? (int?)null
                        : power == 0x0 ? Math.Min(level * 10 + 5, 100)
                        : power == 0x1 ? Math.Max((level - 1) * 10, 0)
                        : power == 0x2 ? 100 : (int?)null;
                    d["battery"] = percent;
                    d["power"] = power == 0x0 ? "discharging" : power == 0x1 ? "charging" : power == 0x2 ? "full"
                        : power == 0xA ? "voltage" : power == 0xB ? "temperature" : power == 0xF ? "error" : "unknown";
                }
                if (p.Status >= 0)
                {
                    d["headphones"] = (p.Status & 0x01) != 0;
                    d["mic"] = (p.Status & 0x02) != 0;
                    d["micMuted"] = (p.Status & 0x04) != 0;
                    d["usbData"] = (p.Status & 0x08) != 0;
                    d["usbPower"] = (p.Status & 0x10) != 0;
                }
                return d;
            }).ToArray();
        }

        static void Emit()
        {
            Program.Emit(new Dictionary<string, object> { { "event", "dualsense" }, { "pads", List(false) } });
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

        [DllImport("ntdll.dll", EntryPoint = "NtQuerySystemInformation")] static extern int NtQueryList(int cls, IntPtr info, int len, out int retLen);
        static readonly object ListGate = new object();
        static IntPtr listBuf = IntPtr.Zero;
        static int listLen;

        /// <summary>
        /// Every process's id and name (without ".exe"). Asked for every few
        /// seconds while games run, so it reads only those two fields from
        /// SystemProcessInformation into a reused buffer; Process.GetProcesses()
        /// would build objects for every thread of every process each time.
        /// </summary>
        public static object List()
        {
            lock (ListGate)
            {
                for (var tries = 0; tries < 5; tries++)
                {
                    if (listBuf == IntPtr.Zero)
                    {
                        listLen = Math.Max(listLen, 1 << 20);
                        listBuf = Marshal.AllocHGlobal(listLen);
                    }
                    int need;
                    var st = NtQueryList(5 /* SystemProcessInformation */, listBuf, listLen, out need);
                    if (st == unchecked((int)0xC0000004)) // STATUS_INFO_LENGTH_MISMATCH: grow and retry
                    {
                        Marshal.FreeHGlobal(listBuf);
                        listBuf = IntPtr.Zero;
                        listLen = Math.Max(need, listLen) + (256 << 10);
                        continue;
                    }
                    if (st != 0) break;
                    // SYSTEM_PROCESS_INFORMATION: ImageName (UNICODE_STRING) at 0x38, UniqueProcessId after BasePriority.
                    int bufferAt = IntPtr.Size == 8 ? 0x40 : 0x3C, pidAt = IntPtr.Size == 8 ? 0x50 : 0x44;
                    var list = new List<object>(512);
                    var p = listBuf;
                    while (true)
                    {
                        var next = Marshal.ReadInt32(p);
                        var len = (ushort)Marshal.ReadInt16(p, 0x38);
                        var namePtr = Marshal.ReadIntPtr(p, bufferAt);
                        var pid = (int)Marshal.ReadIntPtr(p, pidAt).ToInt64();
                        var name = pid == 0 ? "Idle" : namePtr == IntPtr.Zero ? "" : Marshal.PtrToStringUni(namePtr, len / 2);
                        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
                        list.Add(new Dictionary<string, object> { { "pid", pid }, { "name", name } });
                        if (next == 0) break;
                        p += next;
                    }
                    return list;
                }
            }
            var all = new List<object>();
            foreach (var p in System.Diagnostics.Process.GetProcesses())
            {
                try { all.Add(new Dictionary<string, object> { { "pid", p.Id }, { "name", p.ProcessName } }); }
                catch { }
                p.Dispose();
            }
            return all;
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

        /// <summary>
        /// Disk and other I/O a program has done so far (bytes, since it started),
        /// for every process with that name: the same SystemProcessInformation
        /// read as List(), no handle opened. Steam downloads show up as its
        /// writes (the update being staged), which its files don't report live.
        /// </summary>
        public static object Io(string name)
        {
            var list = new List<object>();
            lock (ListGate)
            {
                for (var tries = 0; tries < 5; tries++)
                {
                    if (listBuf == IntPtr.Zero)
                    {
                        listLen = Math.Max(listLen, 1 << 20);
                        listBuf = Marshal.AllocHGlobal(listLen);
                    }
                    int need;
                    var st = NtQueryList(5, listBuf, listLen, out need);
                    if (st == unchecked((int)0xC0000004))
                    {
                        Marshal.FreeHGlobal(listBuf);
                        listBuf = IntPtr.Zero;
                        listLen = Math.Max(need, listLen) + (256 << 10);
                        continue;
                    }
                    if (st != 0 || IntPtr.Size != 8) break;
                    // x64 SYSTEM_PROCESS_INFORMATION: the six IO_COUNTERS (LARGE_INTEGER) end the
                    // fixed part at 0xD0: read/write/other operations, then read/write/other bytes.
                    var p = listBuf;
                    while (true)
                    {
                        var next = Marshal.ReadInt32(p);
                        var len = (ushort)Marshal.ReadInt16(p, 0x38);
                        var namePtr = Marshal.ReadIntPtr(p, 0x40);
                        var pid = (int)Marshal.ReadIntPtr(p, 0x50).ToInt64();
                        var n = namePtr == IntPtr.Zero ? "" : Marshal.PtrToStringUni(namePtr, len / 2);
                        if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
                        if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase))
                        {
                            list.Add(new Dictionary<string, object>
                            {
                                { "pid", pid },
                                { "read", Marshal.ReadInt64(p, 0xE8) },
                                { "write", Marshal.ReadInt64(p, 0xF0) },
                                { "other", Marshal.ReadInt64(p, 0xF8) },
                            });
                        }
                        if (next == 0) break;
                        p += next;
                    }
                    break;
                }
            }
            return list;
        }

        [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32")] static extern bool ShowWindow(IntPtr h, int cmd);

        /// <summary>Top-level windows of the processes with this name, with this title.</summary>
        public static object Windows(string name, string title)
        {
            var pids = new HashSet<uint>();
            foreach (var proc in System.Diagnostics.Process.GetProcessesByName(name ?? ""))
            {
                pids.Add((uint)proc.Id);
                proc.Dispose();
            }
            var list = new List<object>();
            EnumWindowsProc cb = (h, l) =>
            {
                uint owner;
                GetWindowThreadProcessId(h, out owner);
                if (!pids.Contains(owner)) return true;
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, sb.Capacity);
                if (!string.IsNullOrEmpty(title) && sb.ToString() != title) return true;
                if (string.IsNullOrEmpty(title) && (sb.Length == 0 || sb.ToString() == "Default IME" || sb.ToString() == "MSCTFIME UI")) return true;
                list.Add(new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "pid", (int)owner }, { "title", sb.ToString() }, { "visible", IsWindowVisible(h) }, { "minimized", IsIconic(h) } });
                return true;
            };
            EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        [DllImport("user32", SetLastError = true, EntryPoint = "PostMessageW")] static extern bool PostMessageErr(IntPtr h, uint msg, IntPtr w, IntPtr l);

        /// <summary>close: the window menu's Close (what its X does), minimize: minimized without focus.</summary>
        public static object WindowCmd(long hwnd, string cmd)
        {
            var h = new IntPtr(hwnd);
            bool ok;
            if (cmd == "close") ok = PostMessageErr(h, 0x0112 /* WM_SYSCOMMAND */, new IntPtr(0xF060) /* SC_CLOSE */, IntPtr.Zero);
            else if (cmd == "minimize") ok = ShowWindow(h, 7 /* SW_SHOWMINNOACTIVE */);
            else return false;
            if (ok) return true;
            return new Dictionary<string, object> { { "ok", false }, { "error", Marshal.GetLastWin32Error() } };
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
    /* The launcher's own processes while a game runs                      */
    /* ------------------------------------------------------------------ */

    // Only ever called with the launcher's own (Electron) process ids. While a
    // game is in front they get Windows' efficiency mode (EcoQoS: efficient
    // cores, low clocks, no high-resolution timer requests) and a lower
    // priority, and their memory is trimmed, so the game gets the machine.
    static class Qos
    {
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }

        [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref PROCESS_POWER_THROTTLING_STATE info, int size);
        [DllImport("kernel32", SetLastError = true)] static extern bool SetPriorityClass(IntPtr h, uint cls);
        [DllImport("psapi", SetLastError = true)] static extern bool EmptyWorkingSet(IntPtr h);

        const uint SET_QUOTA = 0x0100, SET_INFORMATION = 0x0200, QUERY_LIMITED = 0x1000;
        const uint NORMAL_PRIORITY = 0x20, BELOW_NORMAL_PRIORITY = 0x4000;
        const uint EXECUTION_SPEED = 0x1, IGNORE_TIMER_RESOLUTION = 0x4;

        /// <summary>eco: efficiency mode on/off (off = Windows decides again). trim: page out what isn't in use.</summary>
        public static int Apply(IEnumerable<int> pids, bool eco, bool lower, bool trim)
        {
            var n = 0;
            foreach (var pid in pids)
            {
                var h = OpenProcess(SET_QUOTA | SET_INFORMATION | QUERY_LIMITED, false, pid);
                if (h == IntPtr.Zero) continue;
                try
                {
                    var mask = EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION;
                    var st = new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = eco ? mask : 0, StateMask = eco ? mask : 0 };
                    SetProcessInformation(h, 4 /* ProcessPowerThrottling */, ref st, Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
                    SetPriorityClass(h, eco && lower ? BELOW_NORMAL_PRIORITY : NORMAL_PRIORITY);
                    if (trim) EmptyWorkingSet(h);
                    n++;
                }
                finally
                {
                    CloseHandle(h);
                }
            }
            return n;
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
