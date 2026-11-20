import { useEffect, useMemo, useRef, useState } from 'react'
import { bitable } from '@lark-base-open/js-sdk'
import {
  AlertCircle,
  Check,
  FileImage,
  FolderPlus,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  applyOverwriteValidation,
  formatBytes,
  matchFolders,
  mergeSelectedFiles,
  type FolderGroup,
  type FolderSelectionMode,
  type RecordEntry,
} from './lib/folder-matcher'
import {
  demoContext,
  feishuGateway,
  getDemoRecords,
  getFeishuContext,
  type PluginContext,
  type UploadGateway,
} from './lib/feishu-api'
import './App.css'

type LoadState = 'loading' | 'ready' | 'error'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误，请打开控制台查看详情'
}

function ImageThumb({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return <img className="folder-thumb" src={url} alt="文件夹内首张图片预览" loading="lazy" decoding="async" />
}

const statusText: Record<FolderGroup['status'], string> = {
  matched: '可上传',
  unmatched: '未匹配',
  duplicate: '型号重复',
  empty: '无图片',
  tooMany: '超出上限',
  success: '已完成',
  error: '失败',
}

export default function App() {
  const isDemo = useMemo(() => new URLSearchParams(window.location.search).has('demo'), [])
  const gateway: UploadGateway | null = isDemo ? null : feishuGateway
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [context, setContext] = useState<PluginContext | null>(null)
  const [modelFieldId, setModelFieldId] = useState('')
  const [attachmentFieldId, setAttachmentFieldId] = useState('')
  const [folders, setFolders] = useState<FolderGroup[]>([])
  const [selectionMode, setSelectionMode] = useState<FolderSelectionMode>('parent')
  const [records, setRecords] = useState<RecordEntry[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [matching, setMatching] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadStarted, setUploadStarted] = useState(false)
  const [activeFolderId, setActiveFolderId] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (isDemo) return
    let disposed = false

    void bitable.bridge.getTheme().then((theme) => {
      if (!disposed) document.documentElement.dataset.theme = theme
    }).catch(() => undefined)

    const offThemeChange = bitable.bridge.onThemeChange((event) => {
      document.documentElement.dataset.theme = event.data.theme
    })

    return () => {
      disposed = true
      offThemeChange()
    }
  }, [isDemo])

  useEffect(() => {
    const input = fileInputRef.current
    if (!input) return
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
  }, [loadState])

  useEffect(() => {
    let cancelled = false
    async function initialize() {
      try {
        const nextContext = isDemo ? demoContext : await getFeishuContext()
        if (cancelled) return
        setContext(nextContext)
        setModelFieldId(nextContext.modelFieldId)
        setAttachmentFieldId(nextContext.attachmentFieldId)
        setLoadState('ready')
        if (!isDemo && (!nextContext.modelFieldId || !nextContext.attachmentFieldId)) {
          setNotice('当前表需要至少一个文本/数字字段和一个附件字段')
        }
      } catch (error) {
        if (cancelled) return
        setLoadError(errorMessage(error))
        setLoadState('error')
      }
    }
    initialize()
    return () => {
      cancelled = true
    }
  }, [isDemo])

  async function refreshMatches(
    nextFolders = folders,
    forceRecords = true,
    nextModelFieldId = modelFieldId,
    nextAttachmentFieldId = attachmentFieldId,
  ) {
    if (!context || !nextModelFieldId || !nextAttachmentFieldId || !nextFolders.length) return
    setMatching(true)
    setNotice('')
    try {
      const nextRecords = forceRecords || !records.length
        ? isDemo
          ? getDemoRecords(nextModelFieldId, nextAttachmentFieldId)
          : await gateway!.loadRecords(context.tableId, nextModelFieldId, nextAttachmentFieldId,
            nextFolders.filter((folder) => !folder.isRootGroup && folder.files.length).map((folder) => folder.normalizedName))
        : records
      setRecords(nextRecords)
      const matched = matchFolders(nextFolders, nextRecords)
      setFolders(applyOverwriteValidation(matched, overwrite))
    } catch (error) {
      setNotice(`读取记录失败：${errorMessage(error)}`)
    } finally {
      setMatching(false)
    }
  }

  async function handleFiles(fileList: FileList | null) {
    if (uploadStarted) return
    if (!fileList?.length) {
      setNotice('没有读取到文件；完全空白的文件夹无法被浏览器读取，请至少放入一张图片')
      return
    }
    const selected = Array.from(fileList)
    if (!selected.some((file) => file.webkitRelativePath)) {
      setNotice('没有读到文件夹路径，请通过上方目录选择按钮选择文件夹，而不是普通多选文件')
      return
    }
    const merged = mergeSelectedFiles(folders, selected, selectionMode)
    const hasNewContent = merged.length !== folders.length || merged.some((folder, index) =>
      folder.files.length !== folders[index]?.files.length || folder.skippedFiles !== folders[index]?.skippedFiles)
    if (!hasNewContent) {
      setNotice('所选文件已在当前任务中，未重复添加')
      return
    }
    setFolders(merged)
    await refreshMatches(merged, true)
  }

  function changeField(kind: 'model' | 'attachment', value: string) {
    const nextModelFieldId = kind === 'model' ? value : modelFieldId
    const nextAttachmentFieldId = kind === 'attachment' ? value : attachmentFieldId
    if (kind === 'model') setModelFieldId(value)
    else setAttachmentFieldId(value)
    setRecords([])
    if (folders.length) void refreshMatches(folders, true, nextModelFieldId, nextAttachmentFieldId)
  }

  function changeOverwrite(next: boolean) {
    setOverwrite(next)
    setFolders((current) => applyOverwriteValidation(matchFolders(current, records), next))
  }

  function removeFolder(id: string) {
    setFolders((current) => current.filter((folder) => folder.id !== id))
    setNotice('')
  }

  function resetTask() {
    setFolders([])
    setSelectionMode('parent')
    setRecords([])
    setOverwrite(false)
    setUploadStarted(false)
    setProgress({ current: 0, total: 0 })
    setNotice('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function startUpload() {
    if (!gateway || !context || uploading || isDemo) return
    const pending = folders.filter((folder) => folder.status === 'matched' || folder.status === 'error')
    if (!pending.length) return

    setUploading(true)
    setUploadStarted(true)
    setNotice('')
    setProgress({ current: 0, total: pending.length })

    for (const folder of pending) {
      setActiveFolderId(folder.id)
      setFolders((current) => current.map((item) => item.id === folder.id
        ? { ...item, message: '正在上传并写入记录…' }
        : item))
      try {
        await gateway.uploadFolder(context.tableId, folder, overwrite, attachmentFieldId)
        setFolders((current) => current.map((item) => item.id === folder.id
          ? {
              ...item,
              status: 'success',
              message: overwrite ? `已覆盖为 ${item.files.length} 张图片` : `已追加 ${item.files.length} 张图片`,
              existingCount: overwrite ? item.files.length : item.existingCount + item.files.length,
            }
          : item))
      } catch (error) {
        setFolders((current) => current.map((item) => item.id === folder.id
          ? { ...item, status: 'error', message: errorMessage(error) }
          : item))
      } finally {
        setProgress((current) => ({ ...current, current: current.current + 1 }))
      }
    }

    setActiveFolderId('')
    setUploading(false)
  }

  const matchedCount = folders.filter((folder) => folder.status === 'matched').length
  const successCount = folders.filter((folder) => folder.status === 'success').length
  const failedCount = folders.filter((folder) => folder.status === 'error').length
  const blockedCount = folders.filter((folder) => ['unmatched', 'duplicate', 'empty', 'tooMany'].includes(folder.status)).length
  const pendingCount = matchedCount + failedCount
  const totalImages = folders.reduce((sum, folder) => sum + (folder.status === 'matched' ? folder.files.length : 0), 0)
  const canConfigure = !matching && !uploading && !uploadStarted

  if (loadState === 'loading') {
    return <main className="center-state"><LoaderCircle className="spin" size={26} /><p>正在连接当前多维表格…</p></main>
  }

  if (loadState === 'error') {
    return (
      <main className="center-state setup-state">
        <AlertCircle size={28} />
        <h1>请在多维表格中运行</h1>
        <p>把本项目地址添加到「插件 → 自定义插件」后，即可读取当前数据表。</p>
        <code>{loadError}</code>
        <a className="secondary-button link-button" href="?demo=1">查看界面演示</a>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          void handleFiles(event.target.files)
          event.target.value = ''
        }}
      />

      <header className="app-header">
        <div>
          <p className="overline">BASE ATTACHMENT TOOL</p>
          <h1>型号图片批量上传</h1>
        </div>
        <span className="local-badge"><ShieldCheck size={14} />本地读取</span>
      </header>
      <div className="table-context">
        <span>当前数据表</span>
        <strong>{context?.tableName}</strong>
        {isDemo && <b>演示模式</b>}
      </div>

      <section className="config-section" aria-labelledby="config-title">
        <div className="section-heading">
          <h2 id="config-title">匹配设置</h2>
          {folders.length > 0 && (
            <button className="icon-button" type="button" onClick={() => void refreshMatches()} disabled={!canConfigure} title="重新读取记录并匹配">
              <RefreshCw size={16} className={matching ? 'spin' : ''} /><span>刷新匹配</span>
            </button>
          )}
        </div>
        <div className="field-grid">
          <label>
            <span>型号字段</span>
            <select value={modelFieldId} disabled={!canConfigure} onChange={(event) => changeField('model', event.target.value)}>
              {context?.modelFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </label>
          <label>
            <span>目标附件字段</span>
            <select value={attachmentFieldId} disabled={!canConfigure} onChange={(event) => changeField('attachment', event.target.value)}>
              {context?.attachmentFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </label>
        </div>
        <p className="field-hint">型号文件夹名与匹配字段值完全一致，不做模糊匹配。</p>
      </section>

      <section className="files-section" aria-labelledby="files-title">
        <div className="section-heading">
          <h2 id="files-title">选择图片</h2>
          {folders.length > 0 && canConfigure && (
            <button className="icon-button danger-text" type="button" onClick={resetTask}><Trash2 size={15} /><span>清空</span></button>
          )}
        </div>
        <div className="mode-switch" role="radiogroup" aria-label="目录选择方式">
          <button
            className="mode-option"
            type="button"
            role="radio"
            aria-checked={selectionMode === 'parent'}
            disabled={!canConfigure || folders.length > 0}
            onClick={() => setSelectionMode('parent')}
          >
            总文件夹（批量）
          </button>
          <button
            className="mode-option"
            type="button"
            role="radio"
            aria-checked={selectionMode === 'single'}
            disabled={!canConfigure || folders.length > 0}
            onClick={() => setSelectionMode('single')}
          >
            单个型号文件夹
          </button>
        </div>
        <p className="mode-hint">
          {selectionMode === 'parent'
            ? '目录结构：总文件夹 / 型号子文件夹 / 图片；一次拆出全部型号。'
            : '目录结构：型号文件夹 / 图片；所选文件夹名就是型号。'}
          {folders.length > 0 && ' 清空任务后可切换方式。'}
        </p>
        <button
          className="folder-picker"
          type="button"
          disabled={!canConfigure || !modelFieldId || !attachmentFieldId}
          onClick={() => fileInputRef.current?.click()}
        >
          {matching ? <LoaderCircle className="spin" size={24} /> : <FolderPlus size={24} />}
          <strong>{matching ? '正在读取记录并匹配…' : folders.length
            ? selectionMode === 'parent' ? '继续添加总文件夹' : '继续添加型号文件夹'
            : selectionMode === 'parent' ? '选择总文件夹' : '选择型号文件夹'}</strong>
          <span>{selectionMode === 'parent'
            ? '按一级子文件夹名批量匹配，包含各型号目录中的全部图片'
            : '包含所选型号文件夹及其子目录中的全部图片'}</span>
        </button>

        {folders.length > 0 && (
          <>
            <div className="summary-line" aria-live="polite">
              <span><b>{matchedCount}</b> 个待上传</span>
              <span><b>{totalImages}</b> 张图片</span>
              {blockedCount > 0 && <span className="warning-text"><b>{blockedCount}</b> 个需处理</span>}
              {successCount > 0 && <span className="success-text"><b>{successCount}</b> 个已完成</span>}
            </div>
            <div className="folder-list">
              {folders.map((folder) => (
                <article className={`folder-row status-${folder.status}`} key={folder.id}>
                  <div className="thumb-wrap">
                    {folder.files[0] ? <ImageThumb file={folder.files[0]} /> : <FileImage size={22} />}
                  </div>
                  <div className="folder-info">
                    <div className="folder-title-line">
                      <h3 title={folder.name}>{folder.name}</h3>
                      <span className={`status-label label-${folder.status}`}>
                        {folder.status === 'success' ? <Check size={12} /> : folder.status === 'error' ? <AlertCircle size={12} /> : null}
                        {activeFolderId === folder.id && uploading ? '上传中' : statusText[folder.status]}
                      </span>
                    </div>
                    <p className="file-meta">
                      {folder.files.length} 张图片 · {formatBytes(folder.files.reduce((sum, file) => sum + file.size, 0))}
                      {folder.skippedFiles > 0 && ` · 跳过 ${folder.skippedFiles} 个非图片文件`}
                    </p>
                    <p className="folder-message">{folder.message}</p>
                    {folder.files.length > 0 && (
                      <p className="file-names" title={folder.files.map((file) => file.name).join('、')}>
                        {folder.files.slice(0, 3).map((file) => file.name).join('、')}{folder.files.length > 3 ? ` 等 ${folder.files.length} 个文件` : ''}
                      </p>
                    )}
                  </div>
                  {canConfigure && (
                    <button className="remove-button" type="button" onClick={() => removeFolder(folder.id)} aria-label={`移除文件夹 ${folder.name}`}><X size={16} /></button>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      {folders.length > 0 && (
        <section className="upload-section" aria-labelledby="upload-title">
          <h2 id="upload-title" className="visually-hidden">上传设置</h2>
          <label className={`overwrite-control ${overwrite ? 'is-overwrite' : ''}`}>
            <input type="checkbox" checked={overwrite} disabled={!canConfigure} onChange={(event) => changeOverwrite(event.target.checked)} />
            <span>
              <strong>{overwrite ? '覆盖已有附件' : '追加到已有附件'}</strong>
              <small>{overwrite ? '上传后仅保留本次图片，请谨慎操作' : '保留原附件，把新图片添加到后面'}</small>
            </span>
          </label>

          {(uploading || uploadStarted) && (
            <div className="progress-block" aria-live="polite">
              <div><span>{uploading ? `正在处理 ${progress.current + 1}/${progress.total}` : `处理完成：成功 ${successCount}，失败 ${failedCount}`}</span><b>{Math.round(progress.current / Math.max(progress.total, 1) * 100)}%</b></div>
              <progress max={progress.total} value={progress.current} />
            </div>
          )}

          {isDemo ? (
            <button className="primary-button" type="button" disabled>演示模式不可实际上传</button>
          ) : uploadStarted && !uploading ? (
            <div className="after-upload-actions">
              {failedCount > 0 && <button className="primary-button" type="button" onClick={() => void startUpload()}><RotateCcw size={17} />重试 {failedCount} 个失败项</button>}
              <button className="secondary-button" type="button" onClick={resetTask}>新建上传任务</button>
            </div>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={!pendingCount || matching || uploading}
              onClick={() => void startUpload()}
            >
              {uploading ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}
              {uploading ? '正在上传，请勿关闭' : `${overwrite ? '确认覆盖并上传' : '开始上传'}${pendingCount ? ` · ${pendingCount} 个型号` : ''}`}
            </button>
          )}
        </section>
      )}

      {notice && <div className="notice" role="alert"><AlertCircle size={16} /><span>{notice}</span></div>}
      <footer>图片仅在你与飞书之间传输，不经过第三方服务。</footer>
    </main>
  )
}
