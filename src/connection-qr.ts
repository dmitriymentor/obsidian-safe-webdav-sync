import { Modal, Notice, Setting, type App } from "obsidian";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { Buffer } from "buffer";
import { validateConnection } from "./import-config";
import type { ImportedConfig } from "./types";

interface ConnectionTransfer {
  format: "safe-webdav-sync";
  version: 1;
  connection: ImportedConfig;
  syncConfiguration: boolean;
}

export function connectionUri(connection: ImportedConfig, syncConfiguration: boolean): string {
  const value: ConnectionTransfer = { format: "safe-webdav-sync", version: 1, connection: validateConnection(connection), syncConfiguration };
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "obsidian://safe-webdav-sync?connection=" + encoded;
}

function parseTransfer(input: string): ConnectionTransfer {
  try {
    if (input.length > 12000) throw new Error();
    const url = new URL(input);
    if (url.protocol !== "obsidian:" || url.hostname !== "safe-webdav-sync") throw new Error();
    const encoded = url.searchParams.get("connection");
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (value?.format !== "safe-webdav-sync" || value.version !== 1 || typeof value.syncConfiguration !== "boolean") throw new Error();
    return { format: value.format, version: value.version, connection: validateConnection(value.connection), syncConfiguration: value.syncConfiguration };
  } catch { throw new Error("QR-код не содержит корректного подключения Safe WebDAV Sync"); }
}

export function confirmConnectionQr(app: App, input: string,
  save: (connection: ImportedConfig, syncConfiguration: boolean) => Promise<void>, done?: () => void): void {
  let transfer: ConnectionTransfer;
  try { transfer = parseTransfer(input); }
  catch { new Notice("QR-код не содержит корректного подключения Safe WebDAV Sync", 10000); return; }
  const modal = new Modal(app);
  modal.titleEl.setText("Подключение из QR-кода");
  modal.contentEl.createEl("p", { text: "Проверьте сервер и папку перед сохранением. Синхронизация не запускается автоматически." });
  new Setting(modal.contentEl).setName("Сервер").setDesc(transfer.connection.address);
  new Setting(modal.contentEl).setName("Папка").setDesc(transfer.connection.remoteBaseDir);
  new Setting(modal.contentEl).setName("Настройки и плагины").setDesc(transfer.syncConfiguration ? "Будут синхронизироваться" : "Не будут синхронизироваться");
  new Setting(modal.contentEl).addButton(button => button.setCta().setButtonText("Сохранить подключение").onClick(async () => {
    button.setDisabled(true);
    try {
      await save(transfer.connection, transfer.syncConfiguration);
      modal.close(); done?.();
      new Notice("Подключение сохранено. Запустите синхронизацию и затем перезапустите Obsidian.", 10000);
    } catch (error) { new Notice(error instanceof Error ? error.message : "Не удалось сохранить подключение", 10000); button.setDisabled(false); }
  }));
  modal.onClose = () => { modal.contentEl.empty(); };
  modal.open();
}

export class ConnectionQrModal extends Modal {
  private active = false;
  constructor(app: App, private connection: ImportedConfig, private syncSettings: boolean) { super(app); }
  onOpen(): void {
    this.active = true;
    this.titleEl.setText("QR-код подключения");
    this.contentEl.createEl("p", { text: "На iPhone откройте Safe WebDAV Sync → Сканировать QR и наведите камеру. Можно также использовать приложение «Камера» и открыть ссылку в Obsidian." });
    this.contentEl.createEl("p", { text: "QR содержит пароли. Показывайте его только своему устройству и не публикуйте снимок." });
    const status = this.contentEl.createEl("p", { text: "Создаю QR-код…" });
    const img = this.contentEl.createEl("img", { attr: { alt: "QR-код подключения Safe WebDAV Sync" } });
    img.style.width = "100%"; img.style.maxWidth = "720px"; img.style.height = "auto";
    img.style.display = "block"; img.style.margin = "0 auto";
    void QRCode.toDataURL(connectionUri(this.connection, this.syncSettings), { width: 900, margin: 4, errorCorrectionLevel: "M" })
      .then(data => { if (this.active) { img.src = data; status.remove(); } })
      .catch(() => { if (this.active) status.setText("Подключение слишком длинное для QR-кода. Используйте ручную настройку."); });
  }
  onClose(): void { this.active = false; this.contentEl.empty(); }
}

export class ConnectionQrScanner extends Modal {
  private active = false;
  private stream?: MediaStream;
  private frame?: number;
  private video?: HTMLVideoElement;
  private status!: HTMLElement;
  private file!: HTMLInputElement;
  constructor(app: App, private accepted: (input: string) => void) { super(app); }
  onOpen(): void {
    this.active = true;
    this.titleEl.setText("Сканировать QR-код");
    this.status = this.contentEl.createEl("p", { text: "Покажите QR-код в Safe WebDAV Sync на другом устройстве и разрешите доступ к камере." });
    this.video = this.contentEl.createEl("video", { attr: { playsinline: "", muted: "" } });
    this.video.muted = true; this.video.style.width = "100%"; this.video.style.maxHeight = "50vh";
    this.file = this.contentEl.createEl("input", { attr: { type: "file", accept: "image/*" } });
    this.file.style.display = "none";
    this.file.addEventListener("change", () => { void this.readPhoto(); });
    new Setting(this.contentEl).addButton(button => button.setButtonText("Считать с фотографии").onClick(() => this.file.click()));
    new Setting(this.contentEl).addButton(button => button.setButtonText("Закрыть").onClick(() => this.close()));
    void this.startCamera();
  }
  private async startCamera(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (!this.active) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.video!.srcObject = stream;
      await this.video!.play();
      if (!this.active) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error();
      let previous = 0;
      const tick = (time: number) => {
        if (!this.active) return;
        const video = this.video!;
        if (time - previous > 250 && video.readyState >= 2 && video.videoWidth > 0) {
          previous = time;
          const scale = Math.min(1, 1000 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(pixels.data, pixels.width, pixels.height);
          if (result && this.receive(result.data)) return;
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    } catch {
      this.stopCamera();
      if (this.active) this.status.setText("Obsidian не предоставил доступ к камере. Сфотографируйте QR обычной камерой и нажмите «Считать с фотографии», либо откройте QR-ссылку через приложение «Камера».");
    }
  }
  private receive(input: string): boolean {
    try { parseTransfer(input); }
    catch { this.status.setText("Это не QR подключения Safe WebDAV Sync. Наведите камеру на QR из настроек плагина."); return false; }
    this.close(); this.accepted(input); return true;
  }
  private async readPhoto(): Promise<void> {
    const file = this.file.files?.[0]; if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(); img.src = url; });
      if (!this.active) return;
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error();
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height);
      if (!result) this.status.setText("QR не найден. Выберите чёткую фотографию, где код целиком виден крупным планом.");
      else this.receive(result.data);
    } catch { if (this.active) this.status.setText("Не удалось прочитать фотографию. Выберите изображение QR-кода."); }
    finally { URL.revokeObjectURL(url); this.file.value = ""; }
  }
  private stopCamera(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
  }
  onClose(): void { this.active = false; this.stopCamera(); this.contentEl.empty(); }
}
