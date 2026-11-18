export type FolderSelectionMode = 'parent' | 'single'

export type FolderStatus =
  | 'matched'
  | 'unmatched'
  | 'duplicate'
  | 'empty'
  | 'tooMany'
  | 'success'
  | 'error'

export interface FolderGroup {
  id: string
  name: string
  normalizedName: string
  files: File[]
  fileKeys: Set<string>
  skippedFiles: number
  status: FolderStatus
  message: string
  recordId?: string
  existingCount: number
  isRootGroup?: boolean
}

export interface RecordEntry {
  recordId: string
  modelText: string
  existingCount: number
}

const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp|bmp|svg|avif|tiff?|heic|heif)$/i
export const MAX_ATTACHMENTS = 100

export function normalizeModel(input: unknown): string {
  const value = input === null || input === undefined ? '' : String(input)
  const sanitized = value
    .normalize('NFC')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '_')
  return Array.from(sanitized, (char) => char.charCodeAt(0) < 32 ? '_' : char).join('')
}

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value.map((item) => cellToText(item)).join('')
  }
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>
    if ('text' in item) return cellToText(item.text)
    if ('value' in item) return cellToText(item.value)
    return ''
  }
  return String(value)
}

export function modelKeys(value: unknown): string[] {
  const key = normalizeModel(cellToText(value))
  return key ? [key] : []
}

export function isImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSION.test(file.name)
}

function relativePath(file: File): string {
  return String(file.webkitRelativePath || '').replace(/\\/g, '/')
}

function fileKey(file: File): string {
  return `${relativePath(file) || file.name}|${file.size}|${file.lastModified}`
}

function emptyFolder(name: string, isRootGroup = false): FolderGroup {
  const normalizedName = normalizeModel(name)
  return {
    id: isRootGroup ? `__root__:${normalizedName}` : normalizedName,
    name,
    normalizedName: isRootGroup ? '' : normalizedName,
    files: [],
    fileKeys: new Set<string>(),
    skippedFiles: 0,
    status: 'empty',
    message: '未发现图片',
    existingCount: 0,
    isRootGroup,
  }
}

/**
 * 单个型号模式：A001/图片.jpg → A001。
 * 总文件夹模式：商品图片/A001/图片.jpg → A001；更深层子目录仍归入对应型号。
 * 重复添加同一目录时按完整相对路径、大小和修改时间去重。
 */
export function mergeSelectedFiles(
  current: FolderGroup[],
  selected: FileList | File[],
  mode: FolderSelectionMode = 'single',
): FolderGroup[] {
  const folders = current.map((folder) => ({
    ...folder,
    files: [...folder.files],
    fileKeys: new Set(folder.fileKeys),
  }))
  const byId = new Map(folders.map((folder) => [folder.id, folder]))

  for (const file of Array.from(selected)) {
    const segments = relativePath(file).split('/').filter(Boolean)
    if (!segments.length) continue

    const isRootGroup = mode === 'parent' && segments.length <= 2
    const modelFolderName = mode === 'parent' && segments.length > 2 ? segments[1] : segments[0]
    const folderName = isRootGroup ? `${segments[0]}（根目录散图）` : modelFolderName
    if (!folderName) continue

    const candidate = emptyFolder(folderName, isRootGroup)
    const id = candidate.id
    let folder = byId.get(id)
    if (!folder) {
      folder = candidate
      folders.push(folder)
      byId.set(id, folder)
    }

    const key = fileKey(file)
    if (folder.fileKeys.has(key)) continue
    folder.fileKeys.add(key)

    if (!isImage(file)) {
      folder.skippedFiles += 1
      continue
    }

    folder.files.push(file)
  }

  return folders.map((folder) => ({
    ...folder,
    files: folder.files.sort((a, b) => relativePath(a).localeCompare(relativePath(b), 'zh-CN')),
  }))
}

export function matchFolders(folders: FolderGroup[], records: RecordEntry[]): FolderGroup[] {
  const recordMap = new Map<string, RecordEntry[]>()
  for (const record of records) {
    for (const key of modelKeys(record.modelText)) {
      const list = recordMap.get(key) || []
      list.push(record)
      recordMap.set(key, list)
    }
  }

  return folders.map((folder) => {
    const base: FolderGroup = {
      ...folder,
      recordId: undefined,
      status: 'unmatched',
      message: '未找到对应记录',
      existingCount: 0,
    }

    if (!folder.files.length) {
      return { ...base, status: 'empty', message: '文件夹内没有可上传图片' }
    }
    if (folder.isRootGroup) {
      return {
        ...base,
        status: 'unmatched',
        message: '根目录散图不会上传，请移入对应型号子文件夹后重新选择',
      }
    }

    const matches = recordMap.get(folder.normalizedName) || []
    if (!matches.length) return base
    if (matches.length > 1) {
      return {
        ...base,
        status: 'duplicate',
        message: `表内有 ${matches.length} 条相同型号记录，已阻止上传`,
      }
    }

    const record = matches[0]
    if (folder.files.length > MAX_ATTACHMENTS) {
      return {
        ...base,
        recordId: record.recordId,
        existingCount: record.existingCount,
        status: 'tooMany',
        message: `图片超过单个附件单元格的 ${MAX_ATTACHMENTS} 个上限`,
      }
    }

    return {
      ...base,
      recordId: record.recordId,
      existingCount: record.existingCount,
      status: 'matched',
      message: `已匹配 · 原有 ${record.existingCount} 个附件`,
    }
  })
}

export function applyOverwriteValidation(folders: FolderGroup[], overwrite: boolean): FolderGroup[] {
  return folders.map((folder) => {
    if (folder.status !== 'matched') return folder
    if (!overwrite && folder.existingCount + folder.files.length > MAX_ATTACHMENTS) {
      return {
        ...folder,
        status: 'tooMany',
        message: `追加后共 ${folder.existingCount + folder.files.length} 个附件，超过 ${MAX_ATTACHMENTS} 个上限`,
      }
    }
    return folder
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
