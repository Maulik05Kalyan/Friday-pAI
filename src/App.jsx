import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import "./App.css";

/* ==========================================================================
   Personal AI — upgraded assistant chat frontend
   --------------------------------------------------------------------------
   Single-page React app. No backend required: conversations are seeded with
   mock data and persisted to localStorage. The AI reply is mocked — see the
   `requestAIReply()` function below for the single place to plug in a real
   LLM call (e.g. your existing window.electronAPI.askAI, or a fetch() to
   OpenAI / Anthropic / your own server).

   Features implemented:
     1.  Chat history sidebar (each chat in its own bounded box)
     2.  Dark / light theme toggle
     3.  LLM chat interface (composer + response area)
     4.  AI vs. user message separation
     5.  File upload (attach files to a message)
     6.  Chat search (title + message content, with highlighting)
     7.  New chat
     8.  Pin chats
     9.  Conversation date & details
     10. Auto-scroll + scroll-to-bottom button
     11. Voice-to-text (Web Speech API)
     12. Chat share
     13. Chat delete
     14. Resizable sidebar (drag the edge, double-click to reset)
     15. Collapsible sidebar (full-width chat)
   ========================================================================== */

const STORAGE = {
  conversations: "pai.conversations.v2",
  active: "pai.activeId.v2",
  theme: "pai.theme.v2",
  sidebarWidth: "pai.sidebarWidth.v1",
  sidebarCollapsed: "pai.sidebarCollapsed.v1",
};

const SIDEBAR_DEFAULT = 290;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 480;

const uid = () => Math.random().toString(36).slice(2, 10);
const nowMs = () => Date.now();

/* --------------------------------------------------------------------------
   MOCK SEED DATA — so every feature is demonstrable with no backend
   -------------------------------------------------------------------------- */
function seedConversations() {
  const t = nowMs();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  return [
    {
      id: "c-api-design",
      title: "Designing a REST API in Node",
      pinned: true,
      createdAt: t - 2 * DAY,
      updatedAt: t - 40 * MIN,
      messages: [
        {
          id: uid(),
          role: "user",
          content: "Help me design a REST API for a task manager in Node.",
          ts: t - 2 * DAY,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "Great project. Start with these resource routes: GET /tasks, POST /tasks, GET /tasks/:id, PATCH /tasks/:id, DELETE /tasks/:id. Keep the handlers thin, push the logic into a service layer, and validate every payload with zod before it touches the database.",
          ts: t - 2 * DAY + 30 * 1000,
        },
        {
          id: uid(),
          role: "user",
          content: "Should I use Express or Fastify?",
          ts: t - 40 * MIN,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "Both are solid. Fastify is faster and has schema validation built in; Express has the larger ecosystem. If you already know Express, ship with it and revisit later — the architecture matters far more than the framework at this stage.",
          ts: t - 39 * MIN,
        },
      ],
    },
    {
      id: "c-useeffect",
      title: "Understanding useEffect dependencies",
      pinned: false,
      createdAt: t - 5 * HOUR,
      updatedAt: t - 3 * HOUR,
      messages: [
        {
          id: uid(),
          role: "user",
          content: "Why does my useEffect run twice in React 18?",
          ts: t - 5 * HOUR,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "React 18 StrictMode intentionally mounts, unmounts and remounts components in development so you can catch missing cleanup. It does not happen in production builds. If your effect is safe to run twice — or you add a proper cleanup — you are fine.",
          ts: t - 5 * HOUR + 45 * 1000,
        },
        {
          id: uid(),
          role: "user",
          content: "How do I add cleanup for a fetch?",
          ts: t - 3 * HOUR,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "Use an AbortController: create it at the top of the effect, pass its signal to fetch, and call controller.abort() in the returned cleanup function. Also guard setState with an 'ignore' flag so a late response cannot update unmounted state.",
          ts: t - 3 * HOUR + 20 * 1000,
        },
      ],
    },
    {
      id: "c-manali",
      title: "Trip plan: Manali in December",
      pinned: false,
      createdAt: t - 1 * DAY - 6 * HOUR,
      updatedAt: t - 1 * DAY,
      messages: [
        {
          id: uid(),
          role: "user",
          content: "Plan a 5-day trip to Manali for the last week of December.",
          ts: t - 1 * DAY - 6 * HOUR,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "Late December means snow and heavy traffic on the Atal Tunnel route, so plan generous buffers. Day 1: arrive + Old Manali. Day 2: Solang Valley. Day 3: Atal Tunnel & Sissu. Day 4: Naggar castle + local cafes. Day 5: Kasol day-trip and return. Book hotels early — prices double after 20 December.",
          ts: t - 1 * DAY - 5 * HOUR,
        },
      ],
    },
    {
      id: "c-sql",
      title: "Optimising a slow SQL query",
      pinned: false,
      createdAt: t - 3 * DAY,
      updatedAt: t - 3 * DAY + 2 * HOUR,
      messages: [
        {
          id: uid(),
          role: "user",
          content: "This query takes 8 seconds. How do I make it faster?",
          ts: t - 3 * DAY,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "Run EXPLAIN ANALYZE first. Common culprits: a missing index on the join column, a function call wrapped around an indexed column (which disables the index), or a SELECT * pulling wide rows. Add a composite index on (user_id, created_at) and see the difference immediately.",
          ts: t - 3 * DAY + 2 * HOUR,
        },
      ],
    },
    {
      id: "c-cover",
      title: "Cover letter for a backend role",
      pinned: false,
      createdAt: t - 6 * DAY,
      updatedAt: t - 6 * DAY + 1 * HOUR,
      messages: [
        {
          id: uid(),
          role: "user",
          content: "Write a short cover letter for a backend engineer role.",
          ts: t - 6 * DAY,
        },
        {
          id: uid(),
          role: "assistant",
          content:
            "Keep it to three paragraphs: (1) who you are and the role you want, (2) one concrete achievement with a number in it — 'cut p95 latency from 800ms to 120ms', (3) why this company specifically. No fluff, no restating your resume.",
          ts: t - 6 * DAY + 1 * HOUR,
        },
      ],
    },
  ];
}

/* --------------------------------------------------------------------------
   Date / text helpers
   -------------------------------------------------------------------------- */
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatFullDate(ts) {
  return new Date(ts).toLocaleString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(ts) {
  const diff = nowMs() - ts;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return formatDate(ts);
}

/* Which sidebar group a conversation belongs to (by last activity). */
function groupLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - DAY) return "Yesterday";
  if (ts >= startOfToday - 7 * DAY) return "Previous 7 days";
  if (ts >= startOfToday - 30 * DAY) return "Previous 30 days";
  return d.getFullYear().toString();
}

const GROUP_ORDER = [
  "Pinned",
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
];

function countWords(conversation) {
  return conversation.messages.reduce((sum, m) => {
    const words = (m.content || "").trim();
    return sum + (words ? words.split(/\s+/).length : 0);
  }, 0);
}

function countFiles(conversation) {
  return conversation.messages.reduce(
    (sum, m) => sum + (m.files ? m.files.length : 0),
    0
  );
}

function previewOf(conversation) {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) return "No messages yet";
  const text = (last.content || "").replace(/\s+/g, " ").trim();
  const clipped = text.length > 60 ? text.slice(0, 60) + "…" : text;
  return (last.role === "user" ? "You: " : "AI: ") + clipped;
}

function titleFrom(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 38 ? clean.slice(0, 38) + "…" : clean;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Wrap every occurrence of `query` inside `text` with <mark>. */
function highlight(text, query) {
  const q = (query || "").trim();
  if (!q) return text;
  const parts = String(text).split(new RegExp(`(${escapeRegExp(q)})`, "ig"));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark key={i} className="hl">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* --------------------------------------------------------------------------
   MOCK AI REPLY
   --------------------------------------------------------------------------
   🔌 REAL API CALL GOES HERE.
   Replace the body of this function with your real model call, for example:

     // Electron (your original approach):
     // return await window.electronAPI.askAI(history);

     // or plain HTTP:
     // const res = await fetch("/api/chat", {
     //   method: "POST",
     //   headers: { "Content-Type": "application/json" },
     //   body: JSON.stringify({ messages: history }),
     // });
     // const data = await res.json();
     // return data.reply;

   `history` is the full array of { role, content } for the active chat and
   `attachments` is the list of files the user attached to this message.
   -------------------------------------------------------------------------- */
function requestAIReply(userText, attachments = []) {
  const text = userText.toLowerCase();
  const delay = 650 + Math.random() * 600;

  let reply;
  if (attachments.length) {
    reply = `I've received ${
      attachments.length
    } attachment${attachments.length > 1 ? "s" : ""} (${attachments
      .map((f) => f.name)
      .join(", ")}). In this demo the files are shown as chips only — wire the upload endpoint in requestAIReply() to actually parse them. Based on your message: "${
      userText || "(no text)"
    }" — here's my take: break the problem into one small, shippable step and verify it before moving on.`;
  } else if (text.includes("code") || text.includes("react") || text.includes("bug")) {
    reply =
      "Let's debug it methodically. 1) Reproduce it with the smallest possible input. 2) Check the console for the exact error and stack frame. 3) Form one hypothesis and test only that. 4) Once it works, add a regression test so it cannot come back. Paste the error text and I'll narrow it down.";
  } else if (text.includes("hello") || text.includes("hi") || text.includes("hey")) {
    reply =
      "Hey! I'm your personal AI assistant. I can help you write and review code, plan a project, summarise documents you attach, or just think out loud with you. What are we working on?";
  } else if (text.includes("plan") || text.includes("roadmap")) {
    reply =
      "Here's a compact plan: Phase 1 — clarify the goal and the constraints in one sentence each. Phase 2 — list the 3 steps that unblock everything else and do those first. Phase 3 — build the smallest version end to end, then iterate. Want me to expand any phase into concrete tasks?";
  } else {
    reply = `Got it — you said: "${userText}". Here's how I'd approach it: start by writing down the single outcome you want, then list the two or three things that must be true for it to work. Tackle the riskiest one first. Ask me a follow-up and I can go deeper on any part of this.`;
  }

  // Simulated network latency so the "thinking" state is visible.
  return new Promise((resolve) => setTimeout(() => resolve(reply), delay));
}

/* ==========================================================================
   APP
   ========================================================================== */
export default function App() {
  /* ---------------------------- state ---------------------------- */
  const [conversations, setConversations] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE.conversations);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (e) {
      /* ignore corrupt storage */
    }
    return seedConversations();
  });

  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem(STORAGE.active) || null;
    } catch (e) {
      return null;
    }
  });

  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE.theme);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {
      /* ignore */
    }
    // Default to the distinctive dark theme. The user can switch to light at
    // any time and the choice is remembered. (index.html also applies the
    // saved theme before React mounts, so there is no light flash.)
    return "dark";
  });

  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [listening, setListening] = useState(false);
  const [toast, setToast] = useState(null);
  const [shareModal, setShareModal] = useState(null); // conversation id or null
  const [deleteTarget, setDeleteTarget] = useState(null); // conversation id or null
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Sidebar size + collapsed state (both are remembered between visits).
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE.sidebarWidth));
      if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) return saved;
    } catch (e) {
      /* ignore */
    }
    return SIDEBAR_DEFAULT;
  });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE.sidebarCollapsed) === "1";
    } catch (e) {
      return false;
    }
  });

  const messagesRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  const toastTimer = useRef(null);

  /* --------------------------- derived --------------------------- */
  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => (m.content || "").toLowerCase().includes(q));
    });
  }, [conversations, searchQuery]);

  const groups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const map = new Map();

    const sorted = [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });

    for (const c of sorted) {
      // While searching, group everything under "Pinned" / "Results"
      // so the matching chats are easy to scan.
      const label = c.pinned
        ? "Pinned"
        : q
        ? "Results"
        : groupLabel(c.updatedAt);
      if (!map.has(label)) map.set(label, []);
      map.get(label).push(c);
    }

    const order = [...GROUP_ORDER, "Results"];
    return [...map.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map(([label, items]) => ({ label, items }));
  }, [filtered, searchQuery]);

  /* --------------------------- effects --------------------------- */
  // Apply the theme to <html> so body/background follow too.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE.theme, theme);
    } catch (e) {
      /* ignore */
    }
  }, [theme]);

  // Persist conversations.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.conversations, JSON.stringify(conversations));
    } catch (e) {
      /* ignore */
    }
  }, [conversations]);

  // Persist the active chat id.
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(STORAGE.active, activeId);
      else localStorage.removeItem(STORAGE.active);
    } catch (e) {
      /* ignore */
    }
  }, [activeId]);

  // Remember sidebar size and collapsed state.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.sidebarWidth, String(sidebarWidth));
      localStorage.setItem(STORAGE.sidebarCollapsed, collapsed ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
  }, [sidebarWidth, collapsed]);

  // Auto-select the most recent chat on first load.
  useEffect(() => {
    if (!activeId && conversations.length) {
      const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
      setActiveId(sorted[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to the newest message whenever the thread grows or changes.
  // requestAnimationFrame lets the browser lay out the new row first, so
  // scrollHeight is accurate and the newest message is always in view.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setShowScrollBtn(false);
    });
    return () => cancelAnimationFrame(id);
  }, [activeId, active?.messages.length, thinking]);

  // Auto-resize the composer textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [input]);

  /* --------------------------- helpers --------------------------- */
  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const toggleTheme = () =>
    setTheme((t) => (t === "dark" ? "light" : "dark"));

  const patchConversation = useCallback((id, updater) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updater(c) } : c))
    );
  }, []);

  /* ---------------- SIDEBAR: resize + collapse ---------------- */
  function startResize(event) {
    event.preventDefault();
    document.body.classList.add("resizing");

    const onMove = (e) => {
      // keep the width between the min and max limits
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX)));
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function toggleSidebar() {
    // phone: slide-in drawer, desktop: collapse for a full-width chat
    if (window.innerWidth <= 760) setSidebarOpen((o) => !o);
    else setCollapsed((c) => !c);
  }

  /* ---------------- 7. NEW CHAT ---------------- */
  function newChat() {
    const fresh = {
      id: uid(),
      title: "New chat",
      pinned: false,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      messages: [],
    };
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setInput("");
    setPendingFiles([]);
    setSearchQuery("");
    setSidebarOpen(false);
    setThinking(false);
    setTimeout(() => textareaRef.current?.focus(), 60);
    showToast("New chat started");
  }

  const selectChat = (id) => {
    setActiveId(id);
    setSidebarOpen(false);
    setDetailsOpen(false);
  };

  /* ---------------- 8. PIN CHATS ---------------- */
  function togglePin(id) {
    let pinnedNow = false;
    patchConversation(id, (c) => {
      pinnedNow = !c.pinned;
      return { pinned: !c.pinned };
    });
    showToast(pinnedNow ? "Chat pinned" : "Chat unpinned");
  }

  /* ---------------- 13. DELETE ---------------- */
  function requestDelete(id) {
    setDeleteTarget(id);
  }

  function confirmDelete() {
    const id = deleteTarget;
    if (!id) return;
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (activeId === id) {
      const sorted = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt);
      setActiveId(sorted.length ? sorted[0].id : null);
    }
    setDeleteTarget(null);
    showToast("Chat deleted");
  }

  /* ---------------- 5. FILE UPLOAD ---------------- */
  function handleFiles(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const mapped = files.map((f) => ({
      id: uid(),
      name: f.name,
      size: f.size,
      type: f.type || "file",
    }));
    setPendingFiles((prev) => [...prev, ...mapped]);
    showToast(`${mapped.length} file${mapped.length > 1 ? "s" : ""} attached`);
    event.target.value = "";
  }

  const removePendingFile = (id) =>
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));

  /* ---------------- 3. SEND MESSAGE ---------------- */
  async function sendMessage() {
    const text = input.trim();
    const files = pendingFiles;
    if ((!text && !files.length) || thinking) return;

    let targetId = activeId;

    // If there is no active chat, create one on the fly.
    if (!targetId) {
      const fresh = {
        id: uid(),
        title: "New chat",
        pinned: false,
        createdAt: nowMs(),
        updatedAt: nowMs(),
        messages: [],
      };
      setConversations((prev) => [fresh, ...prev]);
      setActiveId(fresh.id);
      targetId = fresh.id;
    }

    const userMessage = {
      id: uid(),
      role: "user",
      content: text,
      files: files.length ? files : undefined,
      ts: nowMs(),
    };

    // Append the user's message; also set the chat title from the first one.
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== targetId) return c;
        const isFirst = c.messages.length === 0;
        return {
          ...c,
          title: isFirst && text ? titleFrom(text) : c.title,
          messages: [...c.messages, userMessage],
          updatedAt: nowMs(),
        };
      })
    );

    setInput("");
    setPendingFiles([]);
    setThinking(true);

    // Build the history we would send to a real model.
    const history = [
      ...(conversations.find((c) => c.id === targetId)?.messages || []),
      userMessage,
    ].map((m) => ({ role: m.role, content: m.content }));

    try {
      // 🔌 Replace inside requestAIReply() with your real model call.
      const reply = await requestAIReply(text, files);

      const aiMessage = { id: uid(), role: "assistant", content: reply, ts: nowMs() };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? { ...c, messages: [...c.messages, aiMessage], updatedAt: nowMs() }
            : c
        )
      );
      // `history` is intentionally kept in scope as the payload shape for a
      // real API call (see requestAIReply for the drop-in example).
      void history;
    } catch (error) {
      console.error(error);
      const errMessage = {
        id: uid(),
        role: "assistant",
        content: "Sorry, I couldn't connect to the AI right now.",
        ts: nowMs(),
      };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId ? { ...c, messages: [...c.messages, errMessage] } : c
        )
      );
    } finally {
      setThinking(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  /* ---------------- 11. VOICE TO TEXT ---------------- */
  function toggleListening() {
    const SR =
      window.SpeechRecognition || window.webkitSpeechRecognition || null;

    if (!SR) {
      showToast("Voice input isn't supported in this browser");
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    let finalText = "";

    recognition.onstart = () => {
      setListening(true);
      showToast("Listening… speak now");
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += chunk;
        else interim += chunk;
      }
      setInput((prev) => (finalText || interim ? finalText + interim : prev));
    };
    recognition.onerror = () => {
      setListening(false);
      showToast("Couldn't hear that — try again");
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (e) {
      setListening(false);
    }
  }

  /* ---------------- 12. SHARE ---------------- */
  const shareLinkFor = (id) => `https://personal-ai.app/share/${id}`;

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch (e) {
      // Fallback for browsers without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast("Copied to clipboard");
      } catch (err) {
        showToast("Copy failed — select manually");
      }
      document.body.removeChild(ta);
    }
  }

  function transcriptOf(conversation) {
    return conversation.messages
      .map((m) => `${m.role === "user" ? "You" : "AI"}: ${m.content}`)
      .join("\n\n");
  }

  /* ---------------- 10. SCROLL ---------------- */
  function onMessagesScroll() {
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distanceFromBottom > 160);
  }

  function scrollToBottom() {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  /* --------------------------- render --------------------------- */
  const shareTarget = conversations.find((c) => c.id === shareModal) || null;
  const deleteConv = conversations.find((c) => c.id === deleteTarget) || null;

  return (
    <div className="app">
      {/* ================= SIDEBAR ================= */}
      <aside
        className={`sidebar ${sidebarOpen ? "open" : ""} ${
          collapsed ? "collapsed" : ""
        }`}
        style={{ "--sidebar-w": `${sidebarWidth}px` }}
      >
        <div className="sidebar-head">
          <div className="brand">
            <div className="brand-mark">✦</div>
            <div className="brand-text">
              <strong>Personal AI</strong>
              <span>Upgraded assistant</span>
            </div>
          </div>

          <button className="new-chat" onClick={newChat}>
            <span className="plus">＋</span> New chat
          </button>

          {/* 6. CHAT SEARCH */}
          <div className="search">
            <span className="search-icon">⌕</span>
            <input
              type="text"
              placeholder="Search chats & messages…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* 1. CHAT HISTORY */}
        <div className="sidebar-list">
          {groups.length === 0 && (
            <div className="list-empty">
              <p>No chats match “{searchQuery}”.</p>
              <button className="ghost-btn" onClick={() => setSearchQuery("")}>
                Clear search
              </button>
            </div>
          )}

          {groups.map((group) => (
            <div className="group" key={group.label}>
              <div className="group-label">{group.label}</div>
              {group.items.map((c) => (
                <div
                  key={c.id}
                  className={`chat-row ${c.id === activeId ? "active" : ""}`}
                  onClick={() => selectChat(c.id)}
                >
                  <div className="chat-row-body">
                    <div className="chat-row-title">
                      <span className="title-text">
                        {highlight(c.title, searchQuery)}
                      </span>
                      {c.pinned && <span className="pin-flag">📌</span>}
                    </div>
                    <div className="chat-row-preview">
                      {highlight(previewOf(c), searchQuery)}
                    </div>
                    <div className="chat-row-meta">
                      <span>{relativeTime(c.updatedAt)}</span>
                      <span className="dot">•</span>
                      <span>
                        {c.messages.length} msg{c.messages.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>

                  <div className="chat-row-actions">
                    <button
                      title={c.pinned ? "Unpin chat" : "Pin chat"}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(c.id);
                      }}
                    >
                      📌
                    </button>
                    <button
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete(c.id);
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          {/* 2. THEME TOGGLE */}
          <button className="theme-toggle" onClick={toggleTheme}>
            <span className={`switch ${theme === "dark" ? "on" : ""}`}>
              <span className="knob" />
            </span>
            <span className="theme-label">
              {theme === "dark" ? "Dark mode" : "Light mode"}
            </span>
            <span className="theme-icon">{theme === "dark" ? "☾" : "☀"}</span>
          </button>
          <div className="storage-note">
            {conversations.length} chats · saved locally
          </div>
        </div>

        {/* 14. DRAG HANDLE to resize the sidebar */}
        {!collapsed && (
          <div
            className="sidebar-resizer"
            onMouseDown={startResize}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
            title="Drag to resize · double-click to reset"
          />
        )}
      </aside>

      {sidebarOpen && (
        <div className="backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      {/* ================= MAIN ================= */}
      <main className="main">
        {/* 9. CONVERSATION DATE & DETAILS (header) */}
        <header className="chat-header">
          {/* 15. hide / show the sidebar (drawer on phones) */}
          <button
            className="icon-btn menu-btn"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
            title="Show / hide sidebar"
          >
            ☰
          </button>

          <div className="header-title">
            <h2>{active ? active.title : "New chat"}</h2>
            <div className="header-meta">
              {active ? (
                <>
                  <span>{formatDate(active.createdAt)}</span>
                  <span className="dot">•</span>
                  <span>
                    {active.messages.length} message
                    {active.messages.length === 1 ? "" : "s"}
                  </span>
                  <span className="dot">•</span>
                  <span>{countWords(active)} words</span>
                  <span className="dot">•</span>
                  <span>Updated {relativeTime(active.updatedAt)}</span>
                </>
              ) : (
                <span>Start a conversation</span>
              )}
            </div>
          </div>

          <div className="header-actions">
            {active && (
              <>
                <button
                  className="ghost-btn"
                  onClick={() => togglePin(active.id)}
                  title={active.pinned ? "Unpin" : "Pin"}
                >
                  {active.pinned ? "📌 Pinned" : "📌 Pin"}
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => setDetailsOpen(true)}
                >
                  ⓘ Details
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => setShareModal(active.id)}
                >
                  ↗ Share
                </button>
                <button
                  className="ghost-btn danger"
                  onClick={() => requestDelete(active.id)}
                >
                  🗑️ Delete
                </button>
              </>
            )}
            <button
              className="icon-btn"
              onClick={toggleTheme}
              title="Toggle theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </header>

        {/* MESSAGE AREA */}
        <div
          className="messages"
          ref={messagesRef}
          onScroll={onMessagesScroll}
        >
          {!active || active.messages.length === 0 ? (
            <div className="hero">
              <div className="ai-visual">
                <div className="glow glow-one" />
                <div className="glow glow-two" />
                <div className="orb">
                  <div className="orb-inner" />
                  <div className="orb-light" />
                </div>
              </div>
              <p className="greeting">YOUR PERSONAL ASSISTANT</p>
              <h1>
                How can I
                <br />
                <span>help you today?</span>
              </h1>
              <p className="description">
                Ask a question, attach a file, or start a new chat. Everything
                here is demo data but every feature works.
              </p>
              <div className="suggestions">
                {[
                  "Explain useEffect cleanup",
                  "Plan a 5-day trip",
                  "Review my SQL query",
                  "Draft a cover letter",
                ].map((s) => (
                  <button
                    key={s}
                    className="suggestion"
                    onClick={() => {
                      setInput(s);
                      textareaRef.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <button className="hero-cta" onClick={newChat}>
                ＋ Start a new chat
              </button>
            </div>
          ) : (
            <div className="thread">
              {active.messages.map((msg) => (
                /* 4. AI vs USER SEPARATION */
                <div
                  key={msg.id}
                  className={`msg-row ${
                    msg.role === "user" ? "from-user" : "from-ai"
                  }`}
                >
                  <div className="avatar">
                    {msg.role === "user" ? "You" : "✦"}
                  </div>
                  <div className="bubble-wrap">
                    <div className="bubble-head">
                      <span className="who">
                        {msg.role === "user" ? "You" : "Personal AI"}
                      </span>
                      <span className="role-badge">
                        {msg.role === "user" ? "USER" : "ASSISTANT"}
                      </span>
                      <span className="msg-time">{formatTime(msg.ts)}</span>
                    </div>
                    <div className="bubble">{msg.content}</div>

                    {msg.files && msg.files.length > 0 && (
                      <div className="msg-files">
                        {msg.files.map((f) => (
                          <div className="file-card" key={f.id}>
                            <span className="file-icon">📄</span>
                            <span className="file-info">
                              <span className="file-name">{f.name}</span>
                              <span className="file-size">
                                {fileSize(f.size)}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {thinking && (
                <div className="msg-row from-ai">
                  <div className="avatar">✦</div>
                  <div className="bubble-wrap">
                    <div className="bubble typing">
                      <span className="t-dot" />
                      <span className="t-dot" />
                      <span className="t-dot" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 10. SCROLL-TO-BOTTOM BUTTON */}
        {showScrollBtn && (
          <button
            className="scroll-bottom"
            onClick={scrollToBottom}
            aria-label="Scroll to latest"
          >
            ↓
          </button>
        )}

        {/* COMPOSER — 3. LLM CHAT INTERFACE */}
        <div className="composer">
          {pendingFiles.length > 0 && (
            <div className="pending-files">
              {pendingFiles.map((f) => (
                <div className="chip" key={f.id}>
                  <span className="chip-icon">📎</span>
                  <span className="chip-name">{f.name}</span>
                  <span className="chip-size">{fileSize(f.size)}</span>
                  <button
                    className="chip-x"
                    onClick={() => removePendingFile(f.id)}
                    aria-label="Remove file"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-box">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Ask your personal AI…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={thinking}
            />

            <div className="composer-actions">
              {/* 5. FILE UPLOAD */}
              <button
                className="round-btn"
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
              >
                📎
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={handleFiles}
              />

              {/* 11. VOICE TO TEXT */}
              <button
                className={`round-btn ${listening ? "listening" : ""}`}
                onClick={toggleListening}
                title="Voice input"
              >
                🎙
              </button>

              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={thinking || (!input.trim() && !pendingFiles.length)}
                title="Send"
              >
                ↑
              </button>
            </div>
          </div>

          <div className="composer-foot">
            <span>Enter to send · Shift + Enter for a new line</span>
            <span className={`status ${thinking ? "busy" : ""}`}>
              ● {thinking ? "Thinking…" : "AI ready"}
            </span>
          </div>
        </div>
      </main>

      {/* ================= MODALS ================= */}

      {/* 9. DETAILS */}
      {detailsOpen && active && (
        <div className="modal-backdrop" onClick={() => setDetailsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Conversation details</h3>
              <button className="modal-x" onClick={() => setDetailsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-title">{active.title}</div>
              <div className="detail-grid">
                <div>
                  <span className="dk">Created</span>
                  <span className="dv">{formatFullDate(active.createdAt)}</span>
                </div>
                <div>
                  <span className="dk">Last updated</span>
                  <span className="dv">
                    {formatFullDate(active.updatedAt)} ({relativeTime(active.updatedAt)})
                  </span>
                </div>
                <div>
                  <span className="dk">Messages</span>
                  <span className="dv">{active.messages.length}</span>
                </div>
                <div>
                  <span className="dk">Your messages</span>
                  <span className="dv">
                    {active.messages.filter((m) => m.role === "user").length}
                  </span>
                </div>
                <div>
                  <span className="dk">AI messages</span>
                  <span className="dv">
                    {active.messages.filter((m) => m.role === "assistant").length}
                  </span>
                </div>
                <div>
                  <span className="dk">Words</span>
                  <span className="dv">{countWords(active)}</span>
                </div>
                <div>
                  <span className="dk">Attachments</span>
                  <span className="dv">{countFiles(active)}</span>
                </div>
                <div>
                  <span className="dk">Pinned</span>
                  <span className="dv">{active.pinned ? "Yes" : "No"}</span>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="ghost-btn" onClick={() => setDetailsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 12. SHARE */}
      {shareTarget && (
        <div className="modal-backdrop" onClick={() => setShareModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Share “{shareTarget.title}”</h3>
              <button className="modal-x" onClick={() => setShareModal(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-note">
                Anyone with this link can view a read-only copy of the
                conversation. (Demo link.)
              </p>
              <div className="share-row">
                <input readOnly value={shareLinkFor(shareTarget.id)} />
                <button
                  className="primary-btn"
                  onClick={() => copyText(shareLinkFor(shareTarget.id))}
                >
                  Copy link
                </button>
              </div>
              <button
                className="ghost-btn full"
                onClick={() => copyText(transcriptOf(shareTarget))}
              >
                ⧉ Copy full transcript
              </button>
            </div>
            <div className="modal-foot">
              <button className="ghost-btn" onClick={() => setShareModal(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 13. DELETE CONFIRM */}
      {deleteConv && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete chat?</h3>
              <button className="modal-x" onClick={() => setDeleteTarget(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-note">
                “{deleteConv.title}” and its {deleteConv.messages.length} message
                {deleteConv.messages.length === 1 ? "" : "s"} will be removed
                from this device. This can't be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="ghost-btn" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button className="danger-btn" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}