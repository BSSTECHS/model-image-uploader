import {
  bitable,
  FieldType,
  type IAttachmentField,
  type IOpenAttachment,
} from '@lark-base-open/js-sdk'
import { cellToText, MAX_ATTACHMENTS, type FolderGroup, type RecordEntry } from './folder-matcher'

export interface FieldOption {
  id: string
  name: string
}

export interface PluginContext {
  tableId: string
  tableName: string
  modelFields: FieldOption[]
  attachmentFields: FieldOption[]
  modelFieldId: string
  attachmentFieldId: string
}

export interface UploadGateway {
  loadRecords(tableId: string, modelFieldId: string, attachmentFieldId: string): Promise<RecordEntry[]>
  uploadFolder(tableId: string, folder: FolderGroup, overwrite: boolean, attachmentFieldId: string): Promise<void>
}

export async function getFeishuContext(): Promise<PluginContext> {
  const table = await bitable.base.getActiveTable()
  const [tableName, allFields] = await Promise.all([table.getName(), table.getFieldMetaList()])
  const modelFields = allFields
    .filter((field) => field.type === FieldType.Text || field.type === FieldType.Number)
    .map((field) => ({ id: field.id, name: field.name }))
  const attachmentFields = allFields
    .filter((field) => field.type === FieldType.Attachment)
    .map((field) => ({ id: field.id, name: field.name }))

  const modelFieldId = modelFields.find((field) => field.name === 'modelNum')?.id || modelFields[0]?.id || ''
  const attachmentFieldId = attachmentFields.find((field) => field.name === '上架图片')?.id || attachmentFields[0]?.id || ''

  return { tableId: table.id, tableName, modelFields, attachmentFields, modelFieldId, attachmentFieldId }
}

export async function loadFeishuRecords(tableId: string, modelFieldId: string, attachmentFieldId: string): Promise<RecordEntry[]> {
  const table = await bitable.base.getTableById(tableId)
  const records: RecordEntry[] = []
  let pageToken: number | undefined

  do {
    const response = await table.getRecordsByPage({ pageSize: 200, pageToken })
    for (const record of response.records) {
      const attachments = record.fields[attachmentFieldId]
      records.push({
        recordId: record.recordId,
        modelText: cellToText(record.fields[modelFieldId]),
        existingCount: Array.isArray(attachments) ? attachments.length : 0,
      })
    }
    pageToken = response.hasMore ? response.pageToken : undefined
  } while (pageToken !== undefined)

  return records
}

function toAttachment(file: File, token: string): IOpenAttachment {
  return {
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    token,
    timeStamp: file.lastModified,
  }
}

export async function uploadFolderToFeishu(
  tableId: string,
  folder: FolderGroup,
  overwrite: boolean,
  attachmentFieldId: string,
): Promise<void> {
  if (!folder.recordId) throw new Error('缺少匹配记录，已停止上传')
  if (!folder.files.length) throw new Error('文件夹内没有图片')

  const tokens: string[] = []
  const chunkSize = 10
  for (let start = 0; start < folder.files.length; start += chunkSize) {
    const chunk = folder.files.slice(start, start + chunkSize)
    const chunkTokens = await bitable.base.batchUploadFile(chunk)
    if (chunkTokens.length !== chunk.length) throw new Error('附件令牌数量与图片数量不一致')
    tokens.push(...chunkTokens)
  }

  const table = await bitable.base.getTableById(tableId)
  if (!attachmentFieldId) throw new Error('未选择目标附件字段')
  const attachmentField = await table.getField<IAttachmentField>(attachmentFieldId)
  const uploaded = folder.files.map((file, index) => toAttachment(file, tokens[index]))
  // 空单元格 getValue 返回 null（类型标注没写），按无附件处理；读到别的东西就停，免得追加时把原附件冲掉
  const current = overwrite ? null : await attachmentField.getValue(folder.recordId)
  if (current != null && !Array.isArray(current)) throw new Error('读取原附件失败，未修改该记录')
  const existing = current ?? []
  if (existing.length + uploaded.length > MAX_ATTACHMENTS) {
    throw new Error(`写入前复核：附件共 ${existing.length + uploaded.length} 个，超过 ${MAX_ATTACHMENTS} 个上限，未修改该记录`)
  }
  await attachmentField.setValue(folder.recordId, [...existing, ...uploaded])
}

export const feishuGateway: UploadGateway = {
  loadRecords: loadFeishuRecords,
  uploadFolder: uploadFolderToFeishu,
}

export const demoContext: PluginContext = {
  tableId: 'tbl_demo',
  tableName: '界面演示 · 商品资料表',
  modelFields: [
    { id: 'modelNum', name: 'modelNum' },
    { id: 'alternateModel', name: '备用型号（演示重匹配）' },
  ],
  attachmentFields: [
    { id: 'images', name: '上架图片' },
    { id: 'backupImages', name: '备用图片（演示重匹配）' },
  ],
  modelFieldId: 'modelNum',
  attachmentFieldId: 'images',
}

export const demoRecords: RecordEntry[] = [
  { recordId: 'rec_demo_1', modelText: 'A001', existingCount: 2 },
  { recordId: 'rec_demo_2', modelText: 'A002', existingCount: 0 },
  { recordId: 'rec_demo_3', modelText: 'DUP001', existingCount: 0 },
  { recordId: 'rec_demo_4', modelText: 'DUP001', existingCount: 1 },
  { recordId: 'rec_demo_5', modelText: 'SPACE 001', existingCount: 0 },
]

export function getDemoRecords(modelFieldId: string, attachmentFieldId: string): RecordEntry[] {
  return demoRecords.map((record) => ({
    ...record,
    modelText: modelFieldId === 'modelNum' ? record.modelText : `ALT-${record.modelText}`,
    existingCount: attachmentFieldId === 'images' ? record.existingCount : 0,
  }))
}
