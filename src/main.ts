import { Modal, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { importRemotelySaveConfig } from "./import-config";
import { SyncEngine } from "./sync";
import type { PersistedData, PluginSettings, SyncProgress, SyncSummary } from "./types";

const DEFAULT_SETTINGS: PluginSettings = {
  autoSync: false,
  syncOnSave: true,
  intervalMs: 300000,
  sourcePluginId: "remotely-save"
};

export default class SafeWebDavSyncPlugin extends Plugin {
  data: PersistedData = { settings: { ...DEFAULT_SETTINGS }, state: {} };
  private running = false;
  private saveTimer: number | undefined;
  private statusEl: HTMLElement | undefined;
  private progressModal: SyncProgressModal | undefined;
  private lastProgress: SyncProgress | undefined;
  private activeDryRun = false;
  private startedAt = 0;

  private clearProgress(): void {
    this.progressModal?.close();
    this.progressModal = undefined;
  }

  private showProgress(): void {
    this.progressModal ??= new SyncProgressModal(this.app, this.activeDryRun, this.startedAt);
    this.progressModal.show();
    if (this.lastProgress) this.progressModal.update(this.lastProgress);
  }

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PersistedData> | null;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(loaded?.settings ?? {}) },
      state: loaded?.state ?? {}
    };
    this.addRibbonIcon("refresh-cw", "Safe WebDAV Sync", () => void this.sync(false, "вручную"));
    this.addCommand({ id: "sync-now", name: "Синхронизировать сейчас", callback: () => void this.sync(false, "командой") });
    this.addCommand({ id: "dry-run", name: "Проверить план без изменений", callback: () => void this.sync(true, "проверка") });
    this.addCommand({ id: "test-connection", name: "Проверить WebDAV и шифрование", callback: () => void this.checkConnection() });
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("Safe Sync: готов");
    this.addSettingTab(new SafeSyncSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("modify", () => {
      if (!this.data.settings.syncOnSave || this.sourcePluginEnabled()) return;
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.sync(false, "после сохранения"), 1200);
    }));
    this.registerInterval(window.setInterval(() => {
      if (this.data.settings.autoSync && !this.sourcePluginEnabled()) void this.sync(false, "по расписанию");
    }, this.data.settings.intervalMs));

    if (this.sourcePluginEnabled()) {
      this.statusEl.setText("Safe Sync: выключите Remotely Save");
      new Notice("Safe WebDAV Sync установлен. Сначала отключите Remotely Save — два синхронизатора нельзя запускать одновременно.", 9000);
    } else if (this.data.settings.autoSync) {
      this.registerInterval(window.setTimeout(() => void this.sync(false, "при запуске"), 1500));
    }
  }

  onunload(): void {
    window.clearTimeout(this.saveTimer);
    this.progressModal?.close();
  }

  sourcePluginEnabled(): boolean {
    const enabled = (this.app as any).plugins?.enabledPlugins;
    return Boolean(enabled?.has?.(this.data.settings.sourcePluginId));
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }

  async checkConnection(): Promise<void> {
    try {
      this.statusEl?.setText("Safe Sync: проверка…");
      const config = await importRemotelySaveConfig(
        this.app.vault.adapter,
        this.data.settings.sourcePluginId,
        this.app.vault.getName()
      );
      const engine = new SyncEngine(this.app, config, this.data.state, () => this.persist());
      await engine.check();
      this.statusEl?.setText("Safe Sync: подключено");
      new Notice("WebDAV доступен, пароль RClone Crypt подходит.");
    } catch (error) {
      this.statusEl?.setText("Safe Sync: ошибка");
      new Notice(`Safe Sync: ${message(error)}`, 10000);
    }
  }

  async sync(dryRun: boolean, reason: string): Promise<void> {
    const interactive = ["вручную", "командой", "настройки", "проверка"].includes(reason);
    if (this.running) {
      // On mobile the status bar may be hidden. Attach to the active run,
      // including an automatic run, rather than only displaying a toast.
      if (interactive) this.showProgress();
      return;
    }
    if (this.sourcePluginEnabled()) {
      new Notice("Синхронизация не запущена: сначала отключите Remotely Save.", 8000);
      return;
    }
    this.running = true;
    this.clearProgress();
    this.activeDryRun = dryRun;
    this.startedAt = Date.now();
    this.lastProgress = { phase: "local", label: "Подготовка…", completed: 0, total: 0 };
    if (interactive) this.showProgress();
    this.statusEl?.setText(dryRun ? "Safe Sync: проверка…" : "Safe Sync: синхронизация…");
    try {
      // Yield once so the dialog paints before reading or encrypting files.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const config = await importRemotelySaveConfig(
        this.app.vault.adapter,
        this.data.settings.sourcePluginId,
        this.app.vault.getName()
      );
      const engine = new SyncEngine(this.app, config, this.data.state, () => this.persist(), (progress) => {
        this.lastProgress = progress;
        this.progressModal?.update(progress);
        const count = progress.total > 1 ? ` ${progress.completed}/${progress.total}` : "";
        this.statusEl?.setText(`Safe Sync: ${progress.label}${count}`);
      });
      const summary = await engine.run(dryRun);
      const report = formatSummary(summary, dryRun);
      this.statusEl?.setText(summary.errors.length ? "Safe Sync: есть ошибки" : "Safe Sync: готов");
      this.progressModal?.finish(report, summary.errors);
      if (!this.progressModal?.visible || summary.conflicts || summary.errors.length) new Notice(`${report}\nЗапуск: ${reason}`, 12000);
      console.info(`[safe-webdav-sync] ${report}`);
    } catch (error) {
      this.statusEl?.setText("Safe Sync: ошибка");
      this.progressModal?.fail(message(error));
      new Notice(`Safe Sync: ${message(error)}`, 12000);
      console.error("[safe-webdav-sync]", error);
    } finally {
      this.running = false;
    }
  }
}

class SyncProgressModal extends Modal {
  visible = false;
  private timer: number | undefined;
  private elapsedEl!: HTMLElement;
  private last: SyncProgress | undefined;
  private percent = 0;
  private readonly startedAt: number;
  private readonly dryRun: boolean;
  private progressEl!: HTMLProgressElement;
  private phaseEl!: HTMLElement;
  private countEl!: HTMLElement;
  private pathEl!: HTMLElement;
  private actionsEl!: HTMLElement;

  constructor(app: App, dryRun: boolean, startedAt: number) {
    super(app);
    this.dryRun = dryRun;
    this.startedAt = startedAt;
  }

  show(): void {
    if (!this.visible) this.open();
  }

  onClose(): void {
    this.visible = false;
    window.clearInterval(this.timer);
  }

  onOpen(): void {
    this.visible = true;
    this.titleEl.setText(this.dryRun ? "Проверка синхронизации" : "Синхронизация");
    this.contentEl.empty();
    this.phaseEl = this.contentEl.createEl("h3", { text: "Подготовка…" });
    this.progressEl = this.contentEl.createEl("progress");
    this.progressEl.max = 100;
    this.progressEl.value = 0;
    this.progressEl.style.width = "100%";
    this.progressEl.style.height = "18px";
    this.progressEl.setAttr("aria-label", "Прогресс синхронизации");
    this.countEl = this.contentEl.createEl("p", { text: "0%" });
    this.pathEl = this.contentEl.createEl("small", { text: "Подключение к серверу…" });
    this.pathEl.style.display = "block";
    this.pathEl.style.overflowWrap = "anywhere";
    this.actionsEl = this.contentEl.createDiv();
    this.actionsEl.style.marginTop = "18px";
    this.elapsedEl = this.contentEl.createEl("small");
    const tick = () => this.elapsedEl.setText(`Прошло ${Math.floor((Date.now() - this.startedAt) / 1000)} с · Закрытие окна не останавливает синхронизацию`);
    tick();
    this.timer = window.setInterval(tick, 1000);
    if (this.last) this.update(this.last);
  }

  update(progress: SyncProgress): void {
    this.last = progress;
    if (!this.progressEl) return;
    const fraction = progress.total > 0 ? progress.completed / progress.total : 0;
    const next = progress.phase === "local" ? fraction * 10
      : progress.phase === "remote" ? 10
      : progress.phase === "files" ? 10 + fraction * 85 : 95 + fraction * 4;
    this.percent = Math.max(this.percent, Math.min(99, Math.round(next)));
    this.phaseEl.setText(progress.label);
    if (progress.phase === "remote" || progress.total === 0) {
      this.progressEl.removeAttribute("value");
      this.countEl.setText(progress.phase === "remote" && progress.completed > 0
        ? `Проверено папок: ${progress.completed} · Выполняется…` : "Выполняется…");
    } else {
      this.progressEl.value = this.percent;
      this.countEl.setText(`${this.percent}% · ${progress.completed} из ${progress.total}`);
    }
    this.pathEl.setText(progress.path ?? "");
  }

  finish(report: string, errors: string[]): void {
    window.clearInterval(this.timer);
    this.elapsedEl.setText(`Завершено за ${Math.floor((Date.now() - this.startedAt) / 1000)} с`);
    this.titleEl.setText(errors.length ? "Синхронизация завершена с ошибками" : "Синхронизация завершена");
    this.phaseEl.setText(report);
    this.progressEl.value = 100;
    this.countEl.setText("100%");
    this.pathEl.setText(errors.length ? errors.slice(0, 3).join("\n") : "Все файлы обработаны.");
    this.addCloseButton();
  }

  fail(error: string): void {
    window.clearInterval(this.timer);
    this.titleEl.setText("Ошибка синхронизации");
    this.phaseEl.setText(error);
    this.pathEl.setText("Файлы, обработанные до ошибки, остаются в безопасном состоянии.");
    this.addCloseButton();
  }

  private addCloseButton(): void {
    this.actionsEl.empty();
    new Setting(this.actionsEl).addButton((button) => button.setCta().setButtonText("Закрыть").onClick(() => this.close()));
  }
}

class SafeSyncSettingTab extends PluginSettingTab {
  plugin: SafeWebDavSyncPlugin;

  constructor(app: App, plugin: SafeWebDavSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Safe WebDAV Sync" });
    containerEl.createEl("small", { text: `Версия ${this.plugin.manifest.version}` });
    containerEl.createEl("p", {
      text: "Плагин локально читает WebDAV и пароль RClone Crypt из Remotely Save. Секреты не попадают в репозиторий."
    });
    const sourceState = this.plugin.sourcePluginEnabled()
      ? "Remotely Save включён — синхронизация заблокирована для защиты от двойного запуска."
      : "Remotely Save выключен — Safe Sync может работать.";
    containerEl.createEl("p", { text: sourceState, cls: this.plugin.sourcePluginEnabled() ? "mod-warning" : "mod-success" });

    new Setting(containerEl)
      .setName("Проверить подключение")
      .setDesc("Проверяет WebDAV и расшифровку имён, не изменяя файлы.")
      .addButton((button) => button.setButtonText("Проверить").onClick(() => void this.plugin.checkConnection()));

    new Setting(containerEl)
      .setName("Проверить план")
      .setDesc("Показывает объём предстоящих действий без записи на Mac или сервер.")
      .addButton((button) => button.setButtonText("Сухой запуск").onClick(() => void this.plugin.sync(true, "настройки")));

    new Setting(containerEl)
      .setName("Синхронизировать")
      .setDesc("Открывает прогресс текущей синхронизации или запускает новую.")
      .addButton((button) => button.setCta().setButtonText("Запустить").onClick(() => void this.plugin.sync(false, "настройки")));

    new Setting(containerEl)
      .setName("Автоматически каждые 5 минут")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.autoSync).onChange(async (value) => {
        this.plugin.data.settings.autoSync = value;
        await this.plugin.persist();
      }));

    new Setting(containerEl)
      .setName("Синхронизировать после сохранения")
      .setDesc("Запуск через 1,2 секунды после изменения файла.")
      .addToggle((toggle) => toggle.setValue(this.plugin.data.settings.syncOnSave).onChange(async (value) => {
        this.plugin.data.settings.syncOnSave = value;
        await this.plugin.persist();
      }));

    containerEl.createEl("h3", { text: "Как обрабатываются конфликты" });
    containerEl.createEl("p", {
      text: "Правки сопоставляются с общей предыдущей версией по содержимому, с учётом смещения строк. Независимые изменения объединяются. При конфликте остаётся вариант из более новой заметки: сравниваются даты updated, иначе — время изменения файлов. При равных датах выбирается серверный вариант. Резервные копии сохраняются отдельно в Safe Sync Backups."
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSummary(s: SyncSummary, dryRun: boolean): string {
  const prefix = dryRun ? "План" : "Готово";
  const core = `${prefix}: ↑${s.uploaded} ↓${s.downloaded} объединено ${s.merged}, конфликтов ${s.conflicts}, удалено ${s.deleted}`;
  return s.errors.length ? `${core}. Ошибок: ${s.errors.length}` : core;
}
