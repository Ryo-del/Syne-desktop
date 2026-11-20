import { save as pickSave } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../../files/format";
import { iconUrl } from "../../files/icons";
import * as api from "../../lib/api";
import type { MessageAttachment } from "../../types";
import Lightbox from "./Lightbox";

interface Props {
  att: MessageAttachment;
  outgoing: boolean;
  onNotify: (msg: string, kind?: "info" | "error") => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "Не удалось выполнить действие");

async function fetchBlob(att: MessageAttachment): Promise<Blob> {
  return att.source === "hub"
    ? api.hubAttachmentBlob(att.id)
    : api.chatAttachment(att.chat_id.replace(/^cloud:/, ""), Number(att.id));
}

/** Вложение сообщения: фото (миниатюра и просмотр) или файловая карточка. */
export default function Attachment({ att, onNotify }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const isPhoto = att.kind === "photo";
  const thumb = att.thumb ? `data:image/jpeg;base64,${att.thumb}` : null;

  // Полный снимок для просмотра освобождаем при закрытии.
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  async function view() {
    if (busy) return;
    setBusy(true);
    try {
      setUrl(URL.createObjectURL(await fetchBlob(att)));
      setZoom(true);
    } catch (e) {
      onNotify(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (busy) return;
    try {
      if (att.source === "hub") {
        const dest = await pickSave({ defaultPath: att.name });
        if (!dest) return;
        setBusy(true);
        setNote("");
        await api.hubSaveAttachment(att.id, dest);
        setNote("сохранено");
        onNotify(`Сохранено: ${dest}`, "info");
      } else {
        setBusy(true);
        const href = URL.createObjectURL(await fetchBlob(att));
        const a = document.createElement("a");
        a.href = href;
        a.download = att.name;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
        setNote("скачано");
      }
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (isPhoto && thumb) {
    return (
      <>
        <div ref={hostRef}>
          <img className="chat-photo" src={thumb} alt={att.name} draggable={false} onClick={() => void view()} />
        </div>
        {zoom && url ? (
          <Lightbox
            src={url}
            name={att.name}
            onClose={() => {
              setZoom(false);
              setUrl(null);
            }}
            onDownload={() => void download()}
          />
        ) : null}
      </>
    );
  }

  return (
    <button
      type="button"
      className="file-card"
      disabled={busy}
      title={att.source === "hub" ? "Сохранить как…" : "Скачать"}
      onClick={() => void download()}
    >
      <img className="file-card-icon" src={iconUrl(att.name, false)} alt="" draggable={false} />
      <div className="file-card-main">
        <div className="file-card-name">{att.name}</div>
        <div className="file-card-meta">
          {formatBytes(att.size)}
          {busy ? " · загрузка…" : note ? ` · ${note}` : ""}
        </div>
      </div>
    </button>
  );
}
