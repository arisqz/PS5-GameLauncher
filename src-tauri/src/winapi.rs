//! Windows shell bits the library needs: reading .lnk shortcuts (what
//! Electron's shell.readShortcutLink did) and an executable's icon as PNG
//! (what app.getFileIcon did). Both are called from blocking threads.

use std::{ffi::c_void, path::Path};
use windows::core::{Interface, HSTRING};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
use windows::Win32::UI::Shell::{IShellLinkW, SHDefExtractIconW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

pub struct Shortcut {
    pub target: String,
    pub args: String,
    pub cwd: String,
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// COM for the current (blocking) thread, undone when dropped.
struct Com(bool);
impl Com {
    fn init() -> Self {
        Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub fn read_shortcut(path: &Path) -> Option<Shortcut> {
    let _com = Com::init();
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        file.Load(&HSTRING::from(path.as_os_str()), STGM_READ).ok()?;
        let mut target = [0u16; 1024];
        let mut fd = WIN32_FIND_DATAW::default();
        let _ = link.GetPath(&mut target, &mut fd, 0);
        let mut args = [0u16; 4096];
        let _ = link.GetArguments(&mut args);
        let mut cwd = [0u16; 1024];
        let _ = link.GetWorkingDirectory(&mut cwd);
        Some(Shortcut { target: from_wide(&target), args: from_wide(&args), cwd: from_wide(&cwd) })
    }
}

/// The executable's icon (up to 256 px) as a PNG.
pub fn exe_icon_png(path: &Path) -> Option<Vec<u8>> {
    let _com = Com::init();
    unsafe {
        let mut icon = HICON::default();
        SHDefExtractIconW(&HSTRING::from(path.as_os_str()), 0, 0, Some(&mut icon), None, 256).ok().ok()?;
        if icon.is_invalid() {
            return None;
        }
        let png = icon_to_png(icon);
        let _ = DestroyIcon(icon);
        png
    }
}

unsafe fn bitmap_bits(dc: windows::Win32::Graphics::Gdi::HDC, bmp: windows::Win32::Graphics::Gdi::HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(dc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
    (lines == h).then_some(buf)
}

unsafe fn icon_to_png(icon: HICON) -> Option<Vec<u8>> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let color = info.hbmColor;
    let mask = info.hbmMask;
    let cleanup = || {
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
    };
    if color.is_invalid() {
        cleanup();
        return None;
    }
    let mut bm = BITMAP::default();
    if GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void)) == 0 {
        cleanup();
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    let dc = CreateCompatibleDC(None);
    let bgra = bitmap_bits(dc, color, w, h);
    let mask_bits = bitmap_bits(dc, mask, w, h);
    let _ = DeleteDC(dc);
    cleanup();
    let mut px = bgra?;
    // Old icons have no alpha channel: take transparency from the mask.
    if px.chunks(4).all(|p| p[3] == 0) {
        if let Some(m) = mask_bits {
            for (p, mp) in px.chunks_mut(4).zip(m.chunks(4)) {
                p[3] = if mp[0] == 0 { 255 } else { 0 };
            }
        }
    }
    for p in px.chunks_mut(4) {
        p.swap(0, 2); // BGRA -> RGBA
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&px).ok()?;
    }
    Some(out)
}

/* ---------------- Overlay window placement ---------------- */

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW};

/// The full rectangle (physical pixels) of the monitor showing most of the
/// given rectangle; the primary monitor when there is none.
pub fn monitor_rect(x: i32, y: i32, w: i32, h: i32) -> (i32, i32, i32, i32) {
    unsafe {
        let r = RECT { left: x, top: y, right: x + w.max(1), bottom: y + h.max(1) };
        let mon = MonitorFromRect(&r, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(mon, &mut info).as_bool() {
            let m = info.rcMonitor;
            (m.left, m.top, m.right - m.left, m.bottom - m.top)
        } else {
            (0, 0, 1920, 1080)
        }
    }
}

fn hwnd(h: isize) -> HWND {
    HWND(h as *mut c_void)
}

/// Show a window over a rectangle, topmost, without activating it.
pub fn show_topmost_at(h: isize, (x, y, w, ht): (i32, i32, i32, i32)) {
    unsafe {
        let _ = SetWindowPos(hwnd(h), Some(HWND_TOPMOST), x, y, w, ht, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

/// Put a topmost window back on top of other topmost windows.
pub fn raise_topmost(h: isize) {
    unsafe {
        let _ = SetWindowPos(hwnd(h), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    }
}

/// Hide a window shown with show_topmost_at (Tauri doesn't know it is visible).
pub fn hide_window(h: isize) {
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd(h), windows::Win32::UI::WindowsAndMessaging::SW_HIDE);
    }
}
