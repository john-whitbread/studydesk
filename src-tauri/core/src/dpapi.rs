//! Windows DPAPI wrapping. On Windows the encrypted vault is wrapped a second
//! time with a key Windows holds for the current user account, so a copy of
//! the file is useless on another account or machine even if the passphrase
//! is known. On other platforms (development only) this is a no-op.

use crate::Result;

#[cfg(windows)]
const ENTROPY: &[u8] = b"Studydesk vault v1";

#[cfg(windows)]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    let len = u32::try_from(plain.len()).map_err(|_| crate::CoreError::Io("Vault too large.".into()))?;
    let input = CRYPT_INTEGER_BLOB { cbData: len, pbData: plain.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: all pointers are valid for the duration of the call; Windows
    // allocates `out.pbData` with LocalAlloc, which we free below.
    let ok = unsafe {
        CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
    };
    if ok == 0 || out.pbData.is_null() {
        return Err(crate::CoreError::Io("Windows could not protect the vault (DPAPI).".into()));
    }
    // SAFETY: Windows guarantees `cbData` bytes at `pbData`.
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe { LocalFree(out.pbData as _) };
    Ok(v)
}

#[cfg(windows)]
pub fn unprotect(sealed: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    let len = u32::try_from(sealed.len()).map_err(|_| crate::CoreError::VaultCorrupt)?;
    let input = CRYPT_INTEGER_BLOB { cbData: len, pbData: sealed.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: as in `protect`.
    let ok = unsafe {
        CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
    };
    if ok == 0 || out.pbData.is_null() {
        return Err(crate::CoreError::VaultCorrupt);
    }
    let v = zeroize::Zeroizing::new(unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec());
    // Wipe Windows' copy before freeing it.
    unsafe {
        std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
        LocalFree(out.pbData as _);
    }
    Ok(v)
}

#[cfg(not(windows))]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
pub fn unprotect(sealed: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    Ok(zeroize::Zeroizing::new(sealed.to_vec()))
}
