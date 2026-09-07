import { Cipher } from "@fyears/rclone-crypt";

export class RcloneCrypto {
  private readonly cipher = new Cipher("base64");
  private ready: Promise<unknown>;

  constructor(password: string) {
    this.ready = this.cipher.key(password, "");
  }

  async encryptPath(path: string): Promise<string> {
    await this.ready;
    return this.cipher.encryptFileName(path);
  }

  async decryptPath(path: string): Promise<string> {
    await this.ready;
    return this.cipher.decryptFileName(path);
  }

  async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    await this.ready;
    const bytes = await this.cipher.encryptData(new Uint8Array(data), undefined);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    await this.ready;
    const bytes = await this.cipher.decryptData(new Uint8Array(data));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
