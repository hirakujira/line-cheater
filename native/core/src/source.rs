use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::ZipArchive;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Directory,
    Sqlite,
    ImazingArchive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub source_path: String,
    pub kind: SourceKind,
    pub source_bytes: u64,
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_present: bool,
    pub shm_present: bool,
    pub requires_staging: bool,
}

#[derive(Debug, Clone)]
pub struct PreparedSource {
    pub report: SourceReport,
    pub original_path: PathBuf,
    pub account_id: Option<String>,
    pub database_path: PathBuf,
    pub square_database_path: Option<PathBuf>,
    pub unified_group_database_path: Option<PathBuf>,
    pub staging_directory: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct ArchiveDatabaseCandidate {
    name: String,
    bytes: u64,
    priority: u8,
}

pub fn inspect_source(source: &Path) -> Result<SourceReport> {
    let source = source
        .canonicalize()
        .with_context(|| format!("source does not exist: {}", source.display()))?;
    let metadata = fs::metadata(&source)?;
    if metadata.is_dir() {
        let database = find_directory_database(&source)?;
        let database_metadata = fs::metadata(&database)?;
        let wal = sibling_with_suffix(&database, "-wal");
        let shm = sibling_with_suffix(&database, "-shm");
        return Ok(SourceReport {
            source_path: source.display().to_string(),
            kind: SourceKind::Directory,
            source_bytes: 0,
            database_path: database
                .strip_prefix(&source)
                .unwrap_or(&database)
                .to_string_lossy()
                .replace('\\', "/"),
            database_bytes: database_metadata.len(),
            wal_present: wal.is_file(),
            shm_present: shm.is_file(),
            requires_staging: false,
        });
    }

    if is_imazing_archive(&source) {
        let file = File::open(&source)?;
        let mut archive = ZipArchive::new(file).context("cannot open .imazingapp as ZIP")?;
        let candidate = find_archive_database(&mut archive)?;
        let wal_name = format!("{}-wal", candidate.name);
        let shm_name = format!("{}-shm", candidate.name);
        let mut wal_present = false;
        let mut shm_present = false;
        for index in 0..archive.len() {
            let entry = archive.by_index(index)?;
            let name = String::from_utf8_lossy(entry.name_raw());
            wal_present |= name == wal_name;
            shm_present |= name == shm_name;
        }
        return Ok(SourceReport {
            source_path: source.display().to_string(),
            kind: SourceKind::ImazingArchive,
            source_bytes: metadata.len(),
            database_path: candidate.name,
            database_bytes: candidate.bytes,
            wal_present,
            shm_present,
            requires_staging: true,
        });
    }

    if source
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Line.sqlite"))
    {
        let wal = sibling_with_suffix(&source, "-wal");
        let shm = sibling_with_suffix(&source, "-shm");
        return Ok(SourceReport {
            source_path: source.display().to_string(),
            kind: SourceKind::Sqlite,
            source_bytes: metadata.len(),
            database_path: source.display().to_string(),
            database_bytes: metadata.len(),
            wal_present: wal.is_file(),
            shm_present: shm.is_file(),
            requires_staging: false,
        });
    }

    bail!(
        "source must be a LINE backup directory, Line.sqlite, or .imazingapp: {}",
        source.display()
    )
}

pub fn prepare_source(source: &Path, work_dir: &Path) -> Result<PreparedSource> {
    let report = inspect_source(source)?;
    let original_path = PathBuf::from(&report.source_path);
    let account_id = account_id_from_database_path(&report.database_path);
    match report.kind {
        SourceKind::Directory => {
            let database_path = original_path.join(Path::new(&report.database_path));
            let square_database_path = sibling_database(&database_path, "LineSquare.sqlite");
            let unified_group_database_path =
                sibling_database(&database_path, "UnifiedGroup.sqlite");
            Ok(PreparedSource {
                report,
                original_path,
                account_id,
                database_path,
                square_database_path,
                unified_group_database_path,
                staging_directory: None,
            })
        }
        SourceKind::Sqlite => Ok(PreparedSource {
            report,
            database_path: original_path.clone(),
            original_path,
            account_id,
            square_database_path: None,
            unified_group_database_path: None,
            staging_directory: None,
        }),
        SourceKind::ImazingArchive => {
            let staging_directory = work_dir
                .join("staging")
                .join(source_fingerprint(&original_path)?);
            fs::create_dir_all(&staging_directory)?;
            let (database_path, square_database_path, unified_group_database_path) =
                stage_archive_databases(&original_path, &report, &staging_directory)?;
            Ok(PreparedSource {
                report,
                original_path,
                account_id,
                database_path,
                square_database_path,
                unified_group_database_path,
                staging_directory: Some(staging_directory),
            })
        }
    }
}

fn account_id_from_database_path(path: &str) -> Option<String> {
    path.replace('\\', "/")
        .split('/')
        .find_map(|segment| segment.strip_prefix("P_"))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_imazing_archive(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension
            .to_string_lossy()
            .eq_ignore_ascii_case("imazingapp")
    })
}

fn source_fingerprint(path: &Path) -> Result<String> {
    let _ = fs::metadata(path)?;
    let mut reader = BufReader::with_capacity(1024 * 1024, File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sibling_with_suffix(database: &Path, suffix: &str) -> PathBuf {
    let mut name = database.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    database.with_file_name(name)
}

fn sibling_database(database: &Path, filename: &str) -> Option<PathBuf> {
    let candidate = database.with_file_name(filename);
    candidate.is_file().then_some(candidate)
}

fn database_priority(path: &str) -> Option<u8> {
    let normalized = path.replace('\\', "/");
    if !normalized
        .to_ascii_lowercase()
        .ends_with("/messages/line.sqlite")
        && !normalized.eq_ignore_ascii_case("Line.sqlite")
    {
        return None;
    }
    if normalized.contains("/PrivateStore/P_") {
        Some(0)
    } else if normalized.contains("group.com.linecorp.line") {
        Some(1)
    } else {
        Some(2)
    }
}

fn find_directory_database(root: &Path) -> Result<PathBuf> {
    let mut best: Option<(u8, PathBuf)> = None;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_file()
            || !entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("Line.sqlite")
        {
            continue;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let Some(priority) = database_priority(&normalized) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(best_priority, _)| priority < *best_priority)
        {
            best = Some((priority, entry.into_path()));
            if priority == 0 {
                break;
            }
        }
    }
    best.map(|(_, path)| path)
        .context("backup does not contain Messages/Line.sqlite")
}

fn find_archive_database(archive: &mut ZipArchive<File>) -> Result<ArchiveDatabaseCandidate> {
    let mut best: Option<ArchiveDatabaseCandidate> = None;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let name = String::from_utf8_lossy(entry.name_raw()).into_owned();
        let Some(priority) = database_priority(&name) else {
            continue;
        };
        let candidate = ArchiveDatabaseCandidate {
            name,
            bytes: entry.size(),
            priority,
        };
        if best
            .as_ref()
            .is_none_or(|current| candidate.priority < current.priority)
        {
            best = Some(candidate);
            if priority == 0 {
                break;
            }
        }
    }
    best.context(".imazingapp does not contain Messages/Line.sqlite")
}

fn stage_archive_databases(
    source: &Path,
    report: &SourceReport,
    staging_directory: &Path,
) -> Result<(PathBuf, Option<PathBuf>, Option<PathBuf>)> {
    let file = File::open(source)?;
    let mut archive = ZipArchive::new(file)?;
    let candidate = find_archive_database(&mut archive)?;
    let mut wanted = vec![
        candidate.name.clone(),
        format!("{}-wal", candidate.name),
        format!("{}-shm", candidate.name),
    ];
    let square_name = archive_sibling_name(&candidate.name, "LineSquare.sqlite");
    if find_archive_entry(&mut archive, &square_name)?.is_some() {
        wanted.extend([
            square_name.clone(),
            format!("{square_name}-wal"),
            format!("{square_name}-shm"),
        ]);
    }
    let unified_group_name = archive_sibling_name(&candidate.name, "UnifiedGroup.sqlite");
    if find_archive_entry(&mut archive, &unified_group_name)?.is_some() {
        wanted.extend([
            unified_group_name.clone(),
            format!("{unified_group_name}-wal"),
            format!("{unified_group_name}-shm"),
        ]);
    }

    let mut staged_database = None;
    let mut staged_square_database = None;
    let mut staged_unified_group_database = None;
    for wanted_name in wanted {
        let Some(index) = find_archive_entry(&mut archive, &wanted_name)? else {
            continue;
        };
        let filename = Path::new(&wanted_name)
            .file_name()
            .context("invalid database entry path")?;
        let destination = staging_directory.join(filename);
        let expected_size = archive.by_index(index)?.size();
        if destination
            .metadata()
            .is_ok_and(|metadata| metadata.len() == expected_size)
        {
            if wanted_name == report.database_path {
                staged_database = Some(destination);
            } else if wanted_name == square_name {
                staged_square_database = Some(destination);
            } else if wanted_name == unified_group_name {
                staged_unified_group_database = Some(destination);
            }
            continue;
        }
        let temporary = destination.with_extension("part");
        {
            let mut entry = archive.by_index(index)?;
            let mut output = BufWriter::new(
                File::create(&temporary)
                    .with_context(|| format!("cannot create {}", temporary.display()))?,
            );
            std::io::copy(&mut entry, &mut output)?;
            output.flush()?;
        }
        fs::rename(&temporary, &destination)?;
        if wanted_name == report.database_path {
            staged_database = Some(destination);
        } else if wanted_name == square_name {
            staged_square_database = Some(destination);
        } else if wanted_name == unified_group_name {
            staged_unified_group_database = Some(destination);
        }
    }
    Ok((
        staged_database.context("failed to stage Line.sqlite from .imazingapp")?,
        staged_square_database,
        staged_unified_group_database,
    ))
}

fn archive_sibling_name(database_name: &str, filename: &str) -> String {
    database_name
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{filename}"))
        .unwrap_or_else(|| filename.to_string())
}

fn find_archive_entry(archive: &mut ZipArchive<File>, wanted: &str) -> Result<Option<usize>> {
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if entry.name_raw() == wanted.as_bytes() {
            return Ok(Some(index));
        }
    }
    Ok(None)
}
