import { contextBridge, ipcRenderer } from 'electron'

export interface ShanhaiBridge {
  run(message: string): Promise<string>
  onDelta(callback: (text: string) => void): () => void
}

const bridge: ShanhaiBridge = {
  run: (message) => ipcRenderer.invoke('chat:run', message),
  onDelta: (callback) => {
    const listener = (_event: unknown, text: string) => callback(text)
    ipcRenderer.on('chat:delta', listener)
    return () => {
      ipcRenderer.removeListener('chat:delta', listener)
    }
  },
}

// 白名单暴露（contextIsolation: true，只暴露必要能力）
contextBridge.exposeInMainWorld('shanhai', bridge)
