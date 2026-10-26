/**
 * 抽屉里的附件字段：选文件 / 拖拽 / 粘贴截图，多张缩略图，点 X 移除。
 *
 * 附件地址以换行分隔存在记录的 attachment 字段里，所以这里只负责 UI 与上传；
 * 移除已有记录上的附件时会先把记录改掉，再把不再被引用的文件删掉。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import {
  cleanupPmAttachments,
  filesFromClipboard,
  isPmImageAttachment,
  joinAttachments,
  parseAttachments,
  updatePmItem,
  uploadPmFiles,
  type PmEntity,
} from '../../lib/pm';
import { PmIcon, PmImagePreview } from './PmShared';

interface PmAttachmentFieldProps {
  /** 换行分隔的附件地址 */
  value: string;
  onChange: (next: string) => void;
  /** 正在编辑的记录类型：点 X 时用来清掉记录上的引用 */
  entity: PmEntity;
  /** 已有记录的 id；新建时为空 */
  recordId?: string;
  /** 这次抽屉里出现过的地址，关抽屉时由外层统一清理 */
  seenUrls: MutableRefObject<Set<string>>;
  onError: (message: string) => void;
  /** 记录更新后刷新 store */
  onPersisted?: () => void;
}

export default function PmAttachmentField({
  value,
  onChange,
  entity,
  recordId = '',
  seenUrls,
  onError,
  onPersisted,
}: PmAttachmentFieldProps) {
  const attachments = parseAttachments(value);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 页内预览的附件图片（不跳新标签） */
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    for (const file of parseAttachments(value)) seenUrls.current.add(file.url);
  }, [value, seenUrls]);

  const addFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || !files.length) return;
      setUploading(true);
      try {
        const uploaded = await uploadPmFiles(Array.from(files));
        onChange(joinAttachments([...parseAttachments(value), ...uploaded]));
        onError('');
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [onChange, onError, value],
  );

  // 粘贴截图：items + files 都取，避免部分浏览器 files 为空导致贴了没反应
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = filesFromClipboard(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  async function remove(url: string) {
    const next = joinAttachments(attachments.filter((x) => x.url !== url));
    // 编辑已有记录时先把记录改掉，避免「文件删了、记录还指着它」
    if (recordId) {
      try {
        await updatePmItem<unknown>(entity, recordId, { attachment: next });
        onPersisted?.();
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    onChange(next);
    void cleanupPmAttachments([url], recordId);
  }

  return (
    <div
      className={`space-y-2 rounded-lg transition-colors ${
        dragging ? 'bg-[#3370ff]/5 ring-1 ring-[#3370ff]/40' : ''
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer?.files ?? null);
      }}
    >
      {attachments.length ? (
        <ul className="space-y-1.5">
          {attachments.map((file) => (
            <li
              key={file.url}
              className="flex items-center gap-2 rounded-lg border border-stone-200 px-2 py-1.5"
            >
              {isPmImageAttachment(file.url) ? (
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  aria-label={`预览附件 ${file.name}`}
                  className="shrink-0 cursor-zoom-in"
                >
                  <img
                    src={file.url}
                    alt={file.name}
                    className="h-9 w-9 rounded-md border border-stone-100 object-cover"
                  />
                </button>
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-400">
                  <PmIcon name="file" size={15} />
                </span>
              )}
              {isPmImageAttachment(file.url) ? (
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="min-w-0 flex-1 truncate text-left text-sm text-stone-700 hover:text-[#3370ff]"
                >
                  {file.name}
                </button>
              ) : (
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-stone-700 hover:text-[#3370ff]"
                >
                  {file.name}
                </a>
              )}
              <button
                type="button"
                aria-label={`移除附件 ${file.name}`}
                onClick={() => void remove(file.url)}
                className="tw-icon-danger flex h-6 w-6 shrink-0 items-center justify-center rounded"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void addFiles(e.target.files)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-stone-300 px-2.5 text-xs text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-700 disabled:opacity-40"
        >
          <PmIcon name={uploading ? 'file' : 'plus'} size={13} />
          {uploading ? '上传中…' : '上传文件 / 图片'}
        </button>
        <span className="text-xs text-stone-400">
          可拖拽到这里，或直接粘贴截图（⌘V / Ctrl+V），支持多张
        </span>
      </div>

      <PmImagePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
