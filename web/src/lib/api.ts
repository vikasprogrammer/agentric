export interface StateResp {
  tenant: string
  policy: string
  terminalAgents: string[]
  capabilities: { id: string; description: string; defaultRisk: string }[]
}
export interface Session {
  id: string
  agent: string
  title: string
  task: string
  tmux: string
  status: 'running' | 'idle'
  createdAt: number
}
export interface Msg {
  id: string
  type: 'task' | 'update' | 'approval'
  sessionId: string
  agent: string
  title: string
  body: string
  status: 'open' | 'pending' | 'approved' | 'rejected'
  approvalId?: string
  capability?: string
  args?: unknown
  level?: 'head' | 'owner'
  createdAt: number
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json() as Promise<T>
}

export const api = {
  state: () => call<StateResp>('GET', '/api/state'),
  sessions: () => call<Session[]>('GET', '/api/sessions'),
  messages: () => call<Msg[]>('GET', '/api/messages'),
  run: (agent: string, task: string) => call<{ id: string; tmux: string; error?: string }>('POST', '/api/sessions', { agent, task }),
  resolve: (id: string, approved: boolean) => call<{ ok: boolean }>('POST', '/api/approvals/' + id, { approved }),
}
