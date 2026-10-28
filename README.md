# Friday-pAI — Personal AI Desktop Assistant

Friday-pAI is an Electron desktop assistant with a React/Vite interface, an NVIDIA Nemotron-backed chat flow, Tavily web search, local tools, persistent memory/goals, and reusable workflow definitions.

## Requirements

- Node.js 20 or newer (Node.js 22 LTS recommended)
- npm
- API credentials configured locally for the integrations you use

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local `.env` file in the project root. Keep it private and never commit it. Add only the keys you actually use:

   ```env
   NVIDIA_API_KEY=your_nvidia_api_key
   TAVILY_API_KEY=your_tavily_api_key
   ```

3. Start the Vite renderer in one terminal:

   ```bash
   npm run dev
   ```

4. Start Electron in another terminal:

   ```bash
   npm run electron
   ```

The Electron main process loads the renderer from `http://localhost:5173`, so keep the Vite server running while testing the desktop app.

## Workflow engine

Workflow definitions live in `workflows/*.json`. The desktop UI provides workflow discovery, typed input forms, execution status, per-step results/errors, approval controls, and persistent run history.

The engine and task recorder can be checked without calling external APIs:

```bash
npm test
npm run check:main
```

Build and lint the renderer/project with:

```bash
npm run build
npm run lint
```

The shipped workflows use existing tools and/or the configured AI/search integrations. `file-organizer` now builds a move preview and applies the proposed moves only after approval. It stays inside the selected project directory, skips common sensitive files and dependency/build folders, rejects symbolic links and path traversal, refuses overwrites, and attempts rollback if a move batch fails. `project-assistant` saves a Markdown review proposal under `.friday-proposals/` only after approval; it does not edit original source files.

## Privacy and safety

- Keep `.env` and API keys out of source control.
- Workflow project inspection avoids common sensitive files and redacts common key patterns.
- Approval-required workflow steps show their predecessor output as a preview and must be approved explicitly.
- File operations are confined to the chosen project directory; symbolic links, sensitive paths, path traversal and overwrites are rejected.
- Workflow runs, task events, memory, goals, and saved notes are stored locally under Electron's per-user `userData` directory in the desktop app. Existing project-local JSON data is migrated only when the destination does not already exist.
- The Memory screen lets you add, edit and delete facts. Recognizable credential patterns are rejected from saved memory.
- Tests use temporary directories so they do not erase your real run history, goals, or memory.

## Personal AI track direction

The project is being developed toward a private, user-controlled assistant with persistent memory, reusable workflows, and explicit access to tools. NVIDIA Nemotron is used through the existing NVIDIA API integration. Nebius Token Factory/AI Cloud usage and final hackathon packaging must be verified separately before submission; having a key alone is not proof of a successful inference integration.

## Persistent data and verification

The desktop app stores personal memory and workflow run/event history in Electron's per-user `userData` directory. On first launch, existing project-local JSON data is copied only when the destination does not already exist. Workflow memory retrieval uses local BM25 ranking plus sparse word/character vectors, concept expansion, category relevance, and recency. It works offline without sending saved memories to an embedding service, but it is not a neural dense-embedding model. Shipped workflows have deterministic checks for configured output conditions. File-changing steps remain behind explicit approval; file moves and generated artifacts use per-run idempotency protections where possible. A workflow can be cancelled between tool steps, although an already-running external call may finish before cancellation takes effect.

Run automated checks with:

```bash
npm test
npm run check:main
npm run lint
npm run build
```

The memory test launches a separate Node process to verify disk persistence. After installing dependencies on Windows, also launch the Electron app and restart it manually to validate the complete packaged runtime and live API integrations.

## Verification and smoke tests

On Windows PowerShell, from this project directory, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\verify-windows.ps1
```

This performs a clean `npm ci`, automated workflow/memory/history/security/goals/provider tests, main-process syntax checks, ESLint, Vite production build, and optional live API smoke tests. The API smoke test reads `NVIDIA_API_KEY` and `TAVILY_API_KEY` from the process environment or a local `.env` file, never prints the keys, and skips any provider without a configured key. Do not commit `.env`.

To run only the API checks after configuring `.env`:

```powershell
npm run test:api-smoke
```

The automated persistence tests launch a separate Node process to confirm that memory and workflow history survive process restarts. Also perform a full GUI restart check on Windows: run a workflow, close Friday-pAI completely, relaunch it, and verify Memory and workflow history are still visible. A process-level test cannot substitute for validating the packaged Electron GUI on the target machine.

## Reliability fixes in this update

- Workflow run screens show one user-facing result instead of dumping every intermediate tool payload. Step errors and approval previews remain visible when needed.
- The Memory screen includes **Reset for new user**. It clears personal memory only; it does not delete workflow history, goals, or files. Fresh installs no longer import bundled personal-memory facts.
- Project Assistant defaults its project path to the `personal-ai-desktop` root in development, recursively scans supported source/document files, and continues to skip sensitive files, dependencies/build output, and symlink traversal. Packaged builds prefer a user-owned `Documents/personal-ai-desktop` folder if present; otherwise the path field can be changed to the desired project folder.

## Project Assistant folder scope

Project Assistant accepts any existing project folder path, and also offers a native **Browse for project folder** picker. It recursively indexes supported files throughout that selected folder and nested project folders (up to 10,000 files / 20 levels per scan), prioritizes relevant source/configuration files, then reads a small, relevant subset for analysis. It does not recursively read every file's contents: doing so would exceed safe context and latency limits. Sensitive files, symbolic links, dependency folders, and build/cache folders are excluded. The workflow history stores a compact inventory rather than thousands of raw file entries. If the scan reaches its cap, the workflow result marks the index as capped.

## Approval-based Project tools

The **Project tools** screen adds explicit, preview-first filesystem actions for a selected project folder:

- Rename or move the selected project folder (whole-project moves may target another existing parent directory on disk).
- Rename or move files/folders within the selected project.
- Copy files within the project.
- Create folders and text files, or edit a small text file (an adjacent backup is created before replacement).
- Send a selected file/folder to the OS Recycle Bin.

Every operation requires a preview and a separate approval, uses a single-use preview token that expires after five minutes, revalidates paths and source state immediately before execution, and refuses destination overwrites. Individual file actions stay inside the selected project and block sensitive files, symbolic links, and binary text edits. New files/folders require their parent directory to exist. Cross-volume project moves verify a recursive file manifest before attempting to remove the source. If copying or cleanup fails, the app reports the state instead of silently claiming success.

For a whole-project move, enter the full destination path and ensure its parent directory already exists. For rename, choose a new path in the same parent directory. A project move across drives may take longer for large folders. Review the preview carefully before approval.

## Natural-language Project Tools

The Project tools screen accepts a plain-language request. Common explicit actions are parsed locally first, so rename/move/copy/create requests do not fail merely because an AI response was not valid JSON. Requests not covered by the local parser use the configured NVIDIA model with JSON-mode output. Every plan is converted into a strict operation schema, then passed through the same local path and sensitive-file validation used by manual operations. Neither the local parser nor the model executes filesystem changes.

Supported natural-language operation types include renaming or moving the selected project, renaming/moving/copying an individual file, creating a folder or text file, editing a text file, and sending a selected file/folder to the system Recycle Bin. The assistant creates a single-use preview token; the user must inspect the exact paths and explicitly approve before the main process performs the operation. Ambiguous requests should return a clarification instead of guessing. Compound requests are deliberately rejected with guidance to split them into one operation per approval; this prevents phrases such as "create docs and move README" from being misread as one path. Existing destination directories are supported for moving a project or moving/copying a file, while existing destination files are never overwritten. Example supported requests include "Rename this project to SmartAssistant", "Move this project to D:\CollegeProjects", "Create a folder called docs", "Create a folder called components inside src", "Rename file README.md to README-old.md", "Move file README.md into folder docs", and "Copy file README.md to src".

The planner sends the selected project path and the user's instruction to the configured AI provider, not project file contents. Actual file operations are performed locally by the Electron main process after validation. Operations are restricted to the selected project except when moving/renaming the selected project root itself. Sensitive files and symbolic links are blocked for individual file operations.
