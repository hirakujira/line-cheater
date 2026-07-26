use std::sync::OnceLock;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerformanceProfile {
    pub logical_cpus: usize,
    pub physical_memory_bytes: u64,
    pub archive_workers: usize,
    pub sqlite_workers: usize,
    pub line_cache_kib: i64,
    pub square_cache_kib: i64,
    pub unified_cache_kib: i64,
    pub catalog_cache_kib: i64,
    pub line_mmap_bytes: i64,
    pub square_mmap_bytes: i64,
    pub unified_mmap_bytes: i64,
}

impl PerformanceProfile {
    pub fn detect() -> Self {
        Self::from_resources(
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
            physical_memory_bytes(),
        )
    }

    pub fn from_resources(logical_cpus: usize, physical_memory_bytes: Option<u64>) -> Self {
        let logical_cpus = logical_cpus.max(1);
        let physical_memory_bytes = physical_memory_bytes.unwrap_or(4 * GIB).max(GIB);
        let cpu_workers = logical_cpus.div_ceil(2).clamp(1, 12);
        let memory_workers =
            usize::try_from((physical_memory_bytes / (4 * GIB)).clamp(1, 12)).unwrap_or(1);
        let archive_workers = cpu_workers.min(memory_workers).max(1);
        let sqlite_workers = logical_cpus.div_ceil(2).min(memory_workers).clamp(1, 8);

        let line_cache_bytes = (physical_memory_bytes / 48).clamp(64 * MIB, 4 * GIB);
        let square_cache_bytes = (line_cache_bytes / 2).clamp(32 * MIB, 2 * GIB);
        let unified_cache_bytes = (line_cache_bytes / 8).clamp(16 * MIB, 512 * MIB);
        let catalog_cache_bytes = (physical_memory_bytes / 192).clamp(32 * MIB, GIB);
        let line_mmap_bytes = (physical_memory_bytes / 12).clamp(256 * MIB, 16 * GIB);
        let square_mmap_bytes = (line_mmap_bytes / 2).clamp(128 * MIB, 8 * GIB);
        let unified_mmap_bytes = (line_mmap_bytes / 8).clamp(64 * MIB, 2 * GIB);

        Self {
            logical_cpus,
            physical_memory_bytes,
            archive_workers,
            sqlite_workers,
            line_cache_kib: negative_kib(line_cache_bytes),
            square_cache_kib: negative_kib(square_cache_bytes),
            unified_cache_kib: negative_kib(unified_cache_bytes),
            catalog_cache_kib: negative_kib(catalog_cache_bytes),
            line_mmap_bytes: bounded_i64(line_mmap_bytes),
            square_mmap_bytes: bounded_i64(square_mmap_bytes),
            unified_mmap_bytes: bounded_i64(unified_mmap_bytes),
        }
    }

    pub fn archive_workers_for(&self, source_bytes: u64, entries: usize) -> usize {
        if entries <= 1 || source_bytes < 64 * MIB {
            return 1;
        }
        let size_limit = if source_bytes < 512 * MIB {
            2
        } else if source_bytes < 2 * GIB {
            4
        } else {
            self.archive_workers
        };
        self.archive_workers.min(size_limit).min(entries).max(1)
    }
}

pub fn system_performance_profile() -> &'static PerformanceProfile {
    static PROFILE: OnceLock<PerformanceProfile> = OnceLock::new();
    PROFILE.get_or_init(PerformanceProfile::detect)
}

fn negative_kib(bytes: u64) -> i64 {
    -bounded_i64(bytes / 1024)
}

fn bounded_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(target_os = "macos")]
fn physical_memory_bytes() -> Option<u64> {
    use std::ffi::c_char;
    use std::ffi::c_void;

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            old_value: *mut c_void,
            old_len: *mut usize,
            new_value: *mut c_void,
            new_len: usize,
        ) -> i32;
    }

    let mut bytes = 0_u64;
    let mut length = std::mem::size_of::<u64>();
    // SAFETY: `hw.memsize` is a fixed NUL-terminated key and both output pointers refer to
    // writable values of the sizes reported in `length`.
    let status = unsafe {
        sysctlbyname(
            c"hw.memsize".as_ptr(),
            std::ptr::from_mut(&mut bytes).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (status == 0 && length == std::mem::size_of::<u64>() && bytes > 0).then_some(bytes)
}

#[cfg(target_os = "windows")]
fn physical_memory_bytes() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        memory_load: u32,
        total_physical: u64,
        available_physical: u64,
        total_page_file: u64,
        available_page_file: u64,
        total_virtual: u64,
        available_virtual: u64,
        available_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }

    let mut status = MemoryStatus {
        length: u32::try_from(std::mem::size_of::<MemoryStatus>()).ok()?,
        memory_load: 0,
        total_physical: 0,
        available_physical: 0,
        total_page_file: 0,
        available_page_file: 0,
        total_virtual: 0,
        available_virtual: 0,
        available_extended_virtual: 0,
    };
    // SAFETY: `status` is initialized with the documented structure length and remains writable
    // for the duration of the operating-system call.
    let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
    (succeeded && status.total_physical > 0).then_some(status.total_physical)
}

#[cfg(target_os = "linux")]
fn physical_memory_bytes() -> Option<u64> {
    let contents = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kib = contents
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    kib.checked_mul(1024)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn physical_memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::{GIB, MIB, PerformanceProfile};

    #[test]
    fn scales_resources_without_unbounding_workers_or_sqlite_memory() {
        let small = PerformanceProfile::from_resources(2, Some(4 * GIB));
        assert_eq!(small.archive_workers, 1);
        assert_eq!(small.sqlite_workers, 1);
        assert_eq!(small.line_cache_kib, -87_381);
        assert_eq!(small.line_mmap_bytes, 357_913_941);

        let ultra = PerformanceProfile::from_resources(20, Some(192 * GIB));
        assert_eq!(ultra.archive_workers, 10);
        assert_eq!(ultra.sqlite_workers, 8);
        assert_eq!(ultra.line_cache_kib, -4_194_304);
        assert_eq!(ultra.catalog_cache_kib, -1_048_576);
        assert_eq!(
            ultra.line_mmap_bytes,
            i64::try_from(16 * 1024 * MIB).unwrap()
        );
        assert_eq!(ultra.archive_workers_for(32 * MIB, 10_000), 1);
        assert_eq!(ultra.archive_workers_for(256 * MIB, 10_000), 2);
        assert_eq!(ultra.archive_workers_for(4 * GIB, 10_000), 10);
    }
}
