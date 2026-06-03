"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "agent";
interface Msg {
  role: Role;
  text: string;
  pending?: boolean;
}

const TOKEN_KEY = "gateway_token";

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
    setReady(true);
    // Service Worker 登録（PWA 化）
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  if (!ready) return null;
  if (!token) return <Login onSave={setToken} />;
  return <Chat token={token} onLogout={() => setToken(null)} />;
}

function Login({ onSave }: { onSave: (t: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <main style={styles.loginWrap}>
      <div style={styles.loginCard}>
        <h1 style={styles.loginTitle}>Schedule Gateway</h1>
        <p style={styles.loginHint}>アクセストークン（GATEWAY_TOKEN）を入力してください。</p>
        <input
          style={styles.input}
          type="password"
          autoFocus
          placeholder="GATEWAY_TOKEN"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) save();
          }}
        />
        <button style={styles.primaryBtn} onClick={save} disabled={!value.trim()}>
          保存して開始
        </button>
      </div>
    </main>
  );

  function save() {
    const t = value.trim();
    if (!t) return;
    localStorage.setItem(TOKEN_KEY, t);
    onSave(t);
  }
}

function Chat({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, status]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setStatus("");
    setMsgs((m) => [...m, { role: "user", text }, { role: "agent", text: "", pending: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: text }),
      });

      if (res.status === 401) {
        appendAgent("（認証エラー: トークンが正しくありません）");
        return;
      }
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        appendAgent(`（エラー: ${res.status} ${t}）`);
        return;
      }

      await readSSE(res.body, {
        onMessage: (t) => appendAgent(t),
        onTool: (name) => setStatus(`${name} を実行中…`),
        onDone: () => setStatus(""),
        onError: (m) => appendAgent(`（エラー: ${m}）`),
      });
    } catch (err) {
      appendAgent(`（通信エラー: ${err instanceof Error ? err.message : String(err)}）`);
    } finally {
      setBusy(false);
      setStatus("");
      clearPending();
    }
  }

  function appendAgent(chunk: string) {
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last && last.role === "agent") {
        next[next.length - 1] = { role: "agent", text: last.text + chunk };
      } else {
        next.push({ role: "agent", text: chunk });
      }
      return next;
    });
  }

  function clearPending() {
    setMsgs((m) =>
      m.map((x) => (x.pending ? { ...x, pending: false } : x)).filter((x) => x.text !== "" || !x.pending),
    );
  }

  /** 台帳をリセットし、次回送信で新しいセッションを開始する。 */
  async function resetSession() {
    if (busy) return;
    if (!confirm("会話をクリアして新しいセッションを開始しますか？")) return;
    setBusy(true);
    setStatus("セッションをリセット中…");
    try {
      const res = await fetch("/api/session/reset", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        setStatus(`リセット失敗: ${res.status} ${t}`);
        return;
      }
      setMsgs([]);
      setStatus("新しいセッションを開始しました");
      setTimeout(() => setStatus(""), 2500);
    } catch (err) {
      setStatus(`リセット失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.chatWrap}>
      <header style={styles.header}>
        <span style={styles.headerTitle}>Schedule</span>
        <div style={styles.headerActions}>
          <button style={styles.linkBtn} onClick={resetSession} disabled={busy} title="会話をクリアして新しいセッションを開始">
            リセット
          </button>
          <button style={styles.linkBtn} onClick={onLogout}>
            ログアウト
          </button>
        </div>
      </header>

      <div ref={scrollRef} style={styles.messages}>
        {msgs.length === 0 && (
          <div style={styles.empty}>
            <p>例:</p>
            <p style={styles.exampleQuote}>「6/14 14:00 旭川高専でオンライン登壇を追加して」</p>
            <p style={styles.exampleQuote}>「登録済みの予定を確認して」</p>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={m.role === "user" ? styles.userRow : styles.agentRow}>
            <div style={m.role === "user" ? styles.userBubble : styles.agentBubble}>
              {m.role === "user" ? (
                m.text
              ) : m.text ? (
                <Markdown text={m.text} />
              ) : m.pending ? (
                "…"
              ) : (
                ""
              )}
            </div>
          </div>
        ))}
        {status && <div style={styles.statusLine}>{status}</div>}
      </div>

      <div style={styles.composer}>
        <textarea
          style={styles.textarea}
          rows={1}
          placeholder="メッセージを入力…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy}
        />
        <button style={styles.sendBtn} onClick={send} disabled={busy || !input.trim()}>
          {busy ? "…" : "送信"}
        </button>
      </div>
    </main>
  );
}

/** エージェントの返答を Markdown としてレンダリングする。 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: (props) => (
            <div style={styles.tableWrap}>
              <table style={styles.table} {...props} />
            </div>
          ),
          thead: (props) => <thead style={styles.thead} {...props} />,
          th: (props) => <th style={styles.th} {...props} />,
          td: (props) => <td style={styles.td} {...props} />,
          a: (props) => <a style={styles.link} target="_blank" rel="noreferrer" {...props} />,
          code: ({ className, children, ...props }) => {
            const isBlock = /\n/.test(String(children ?? "")) || (className ?? "").includes("language-");
            return isBlock ? (
              <code style={styles.codeBlock} {...props}>
                {children}
              </code>
            ) : (
              <code style={styles.codeInline} {...props}>
                {children}
              </code>
            );
          },
          pre: (props) => <pre style={styles.pre} {...props} />,
          blockquote: (props) => <blockquote style={styles.blockquote} {...props} />,
          ul: (props) => <ul style={styles.list} {...props} />,
          ol: (props) => <ol style={styles.list} {...props} />,
          h1: (props) => <h1 style={styles.h1} {...props} />,
          h2: (props) => <h2 style={styles.h2} {...props} />,
          h3: (props) => <h3 style={styles.h3} {...props} />,
          hr: (props) => <hr style={styles.hr} {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** ReadableStream を SSE としてパースする。 */
async function readSSE(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onMessage: (text: string) => void;
    onTool: (name: string) => void;
    onDone: () => void;
    onError: (message: string) => void;
  },
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const { event, data } = parseEvent(raw);
      if (!event) continue;
      let payload: any = {};
      try {
        payload = data ? JSON.parse(data) : {};
      } catch {
        /* ignore */
      }
      if (event === "message") handlers.onMessage(payload.text ?? "");
      else if (event === "tool") handlers.onTool(payload.name ?? "ツール");
      else if (event === "done") handlers.onDone();
      else if (event === "error") handlers.onError(payload.message ?? "unknown");
    }
  }
}

function parseEvent(raw: string): { event: string; data: string } {
  let event = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { event, data };
}

const styles: Record<string, React.CSSProperties> = {
  loginWrap: {
    minHeight: "100dvh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  loginCard: {
    width: "100%",
    maxWidth: 380,
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 24,
  },
  loginTitle: { margin: "0 0 8px", fontSize: 22 },
  loginHint: { margin: "0 0 16px", color: "var(--muted)", fontSize: 14 },
  input: {
    width: "100%",
    padding: "12px 14px",
    background: "var(--panel-2)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    outline: "none",
    marginBottom: 12,
  },
  primaryBtn: {
    width: "100%",
    padding: "12px 14px",
    background: "var(--accent)",
    color: "var(--accent-ink)",
    border: "none",
    borderRadius: 10,
    fontWeight: 600,
    cursor: "pointer",
  },
  chatWrap: {
    height: "100dvh",
    display: "flex",
    flexDirection: "column",
    maxWidth: 720,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    paddingTop: "max(12px, env(safe-area-inset-top))",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg)",
  },
  headerTitle: { fontWeight: 700, fontSize: 17 },
  headerActions: { display: "flex", alignItems: "center", gap: 12 },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--muted)",
    fontSize: 13,
    cursor: "pointer",
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  empty: { color: "var(--muted)", fontSize: 14, marginTop: 24 },
  exampleQuote: { margin: "6px 0", color: "var(--text)", opacity: 0.8 },
  userRow: { display: "flex", justifyContent: "flex-end" },
  agentRow: { display: "flex", justifyContent: "flex-start" },
  userBubble: {
    maxWidth: "82%",
    background: "var(--user-bubble)",
    padding: "10px 14px",
    borderRadius: "16px 16px 4px 16px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  agentBubble: {
    maxWidth: "82%",
    background: "var(--agent-bubble)",
    border: "1px solid var(--border)",
    padding: "10px 14px",
    borderRadius: "16px 16px 16px 4px",
    wordBreak: "break-word",
  },
  statusLine: { color: "var(--muted)", fontSize: 13, fontStyle: "italic" },
  tableWrap: { overflowX: "auto", margin: "8px 0" },
  table: {
    borderCollapse: "collapse",
    width: "100%",
    fontSize: 14,
  },
  thead: { background: "var(--panel-2)" },
  th: {
    border: "1px solid var(--border)",
    padding: "6px 10px",
    textAlign: "left",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  td: {
    border: "1px solid var(--border)",
    padding: "6px 10px",
    textAlign: "left",
  },
  link: { color: "var(--accent)", textDecoration: "underline" },
  codeInline: {
    background: "var(--panel-2)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "1px 5px",
    fontSize: "0.88em",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  codeBlock: {
    display: "block",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
  },
  pre: {
    background: "var(--panel-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 12px",
    overflowX: "auto",
    margin: "8px 0",
  },
  blockquote: {
    borderLeft: "3px solid var(--border)",
    margin: "8px 0",
    padding: "2px 0 2px 12px",
    color: "var(--muted)",
  },
  list: { margin: "6px 0", paddingLeft: 22 },
  h1: { fontSize: 20, fontWeight: 700, margin: "12px 0 6px" },
  h2: { fontSize: 18, fontWeight: 700, margin: "12px 0 6px" },
  h3: { fontSize: 16, fontWeight: 700, margin: "10px 0 6px" },
  hr: { border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" },
  composer: {
    display: "flex",
    gap: 8,
    padding: 12,
    paddingBottom: "max(12px, env(safe-area-inset-bottom))",
    borderTop: "1px solid var(--border)",
    background: "var(--bg)",
  },
  textarea: {
    flex: 1,
    resize: "none",
    maxHeight: 140,
    padding: "12px 14px",
    background: "var(--panel-2)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    outline: "none",
  },
  sendBtn: {
    padding: "0 18px",
    background: "var(--accent)",
    color: "var(--accent-ink)",
    border: "none",
    borderRadius: 12,
    fontWeight: 600,
    cursor: "pointer",
    minWidth: 64,
  },
};
