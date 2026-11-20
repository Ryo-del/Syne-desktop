import { useEffect } from "react";

interface ErrorToastProps {
  error: string;
  /** error — красный тост с кнопкой «Закрыть»; info — нейтральный, закрывается сам. */
  kind?: "info" | "error";
  errorToastKey: number;
  onClose: () => void;
}

const INFO_TIMEOUT_MS = 4000;

export default function ErrorToast({
  error,
  kind = "error",
  errorToastKey,
  onClose,
}: ErrorToastProps) {
  const isInfo = kind === "info";

  useEffect(() => {
    if (!error || !isInfo) return;
    const timer = window.setTimeout(onClose, INFO_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, isInfo, errorToastKey]);

  if (!error) {
    return null;
  }

  if (isInfo) {
    return (
      <div
        key={errorToastKey}
        className="error-toast info"
        role="status"
        aria-live="polite"
        onClick={onClose}
      >
        <span className="error-toast-title">Готово</span>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div
      key={errorToastKey}
      className="error-toast"
      role="alert"
      aria-live="assertive"
    >
      <span className="error-toast-title">
        Error
      </span>

      <p>{error}</p>

      <button id="Btnsend" className="Btnsend" onClick={onClose}>
        Закрыть
      </button>
    </div>
  );
}
