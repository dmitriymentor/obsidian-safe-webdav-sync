import { Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { importRemotelySaveConfig } from "./import-config";
import { SyncEngine } from "./sync";
import type { PersistedData, PluginSettings, SyncSummary } from "./types";

const DEFAULT_SETTINGS: PluginSettings = {
  autoSync: true,
  syncOnSave: true,
  intervalMs: 300000,
  sourcePluginId: "remotely-save"
};

export default class SafeWebDavSyncPlugin extends Plugin {
  data: PersistedData = { settings: { ...DEFAULT_SETTINGS }, state: {} };
  private running = false;
  private saveTimer: number | undefined;
  private statusEl: HTMLElement | undefined;

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
      const config = await importRemotelySaveConfig(this.app.vault.adapter, this.data.settings.sourcePluginId);
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
    if (this.running) return;
    if (this.sourcePluginEnabled()) {
      new Notice("Синхронизация не запущена: сначала отключите Remotely Save.", 8000);
      return;
    }
    this.running = true;
    this.statusEl?.setText(dryRun ? "Safe Sync: проверка…" : "Safe Sync: синхронизация…");
    try {
      const config = await importRemotelySaveConfig(this.app.vault.adapter, this.data.settings.sourcePluginId);
      const engine = new SyncEngine(this.app, config, this.data.state, () => this.persist());
      const summary = await engine.run(dryRun);
      const report = formatSummary(summary, dryRun);
      this.statusEl?.setText(summary.errors.length ? "Safe Sync: есть ошибки" : "Safe Sync: готов");
      if (dryRun || summary.conflicts || summary.errors.length) new Notice(`${report}\nЗапуск: ${reason}`, 12000);
      console.info(`[safe-webdav-sync] ${report}`);
    } catch (error) {
      this.statusEl?.setText("Safe Sync: ошибка");
      new Notice(`Safe Sync: ${message(error)}`, 12000);
      console.error("[safe-webdav-sync]", error);
    } finally {
      this.running = false;
    }
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
      .setDesc("Запускает двустороннюю синхронизацию с безопасным слиянием.")
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
      text: "Разные строки Markdown объединяются автоматически. Если одна и та же строка изменена на двух устройствах, обе версии остаются между заметными маркерами, а полные копии сохраняются в папке “Safe Sync Backups” и в зашифрованной служебной папке на сервере."
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
