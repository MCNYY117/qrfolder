/**
 * 扩展名 → Content-Type 映射。
 *
 * Node 没有内置的 MIME 表（不像 Go 的 mime 包），所以这里自己维护一份。
 * 未知扩展名一律 application/octet-stream，并由调用方强制附件下载 ——
 * 绝不让浏览器去猜。
 */

/** 单段扩展名表。键统一为小写、含前导点。 */
const MIME: Record<string, string> = {
  // ---- 文档 ----
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',

  // ---- 纯文本 ----
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.json5': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',

  // ---- 网页与脚本（默认强制下载，见 forceDownloadExtensions）----
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.xsl': 'application/xslt+xml',
  '.svg': 'image/svg+xml',

  // ---- 图片 ----
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.psd': 'image/vnd.adobe.photoshop',

  // ---- 音视频 ----
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',

  // ---- 压缩包 ----
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.zst': 'application/zstd',
  '.iso': 'application/x-iso9660-image',

  // ---- 字体 ----
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // ---- 工程图纸（产品手册场景常见）----
  '.dwg': 'image/vnd.dwg',
  '.dxf': 'image/vnd.dxf',
  '.step': 'model/step',
  '.stp': 'model/step',
  '.iges': 'model/iges',
  '.igs': 'model/iges',
  '.stl': 'model/stl',
  '.3mf': 'model/3mf',
  '.obj': 'model/obj',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',

  // ---- 其他二进制 ----
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.apk': 'application/vnd.android.package-archive',
  '.dmg': 'application/x-apple-diskimage',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.bin': 'application/octet-stream',
  '.dat': 'application/octet-stream',
};

const DEFAULT_MIME = 'application/octet-stream';

/** 判断 Content-Type 是否属于文本类（决定要不要 gzip） */
export function isTextual(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime.startsWith('application/json') ||
    mime.startsWith('application/xml') ||
    mime.startsWith('application/yaml') ||
    mime.startsWith('image/svg+xml') ||
    mime.startsWith('application/javascript') ||
    mime.startsWith('text/javascript')
  );
}

/**
 * 取单段扩展名（小写、含点）。无扩展名或属于点开头的文件名时返回 ''。
 *
 *   'a.pdf'      -> '.pdf'
 *   'a.tar.gz'   -> '.gz'      （两段式请用 lookupMime）
 *   '.env'       -> ''         （点开头视为无扩展名，由 denyRules 按整名匹配）
 *   'README'     -> ''
 *   'a.'         -> ''
 */
export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i).toLowerCase();
}

/**
 * 查 MIME。只看最后一段扩展名。
 *
 * 刻意不做 `.tar.gz` 这类两段式特判：Content-Type 描述的是磁盘上
 * 实际存储的字节，而 .tar.gz 的字节就是 gzip。若报成 application/x-tar，
 * 信任该类型的客户端会在解压时失败。需要知道「里面是 tar」的场景，
 * 应由文件名或业务逻辑判断，不该由 Content-Type 表达。
 */
export function lookupMime(name: string): string {
  const ext = fileExtension(name);
  if (ext === '') return DEFAULT_MIME;
  return MIME[ext] ?? DEFAULT_MIME;
}

/** 供测试与文档列举用 */
export function knownExtensions(): string[] {
  return Object.keys(MIME).sort();
}
