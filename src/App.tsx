import { FileText, X } from "lucide-react";
import { useEffect } from "react";
import { Compose } from "./components/Compose.tsx";
import { Confetti } from "./components/Confetti.tsx";
import { KeyDates } from "./components/KeyDates.tsx";
import { CourseView } from "./components/CourseView.tsx";
import { LockScreen, Setup } from "./components/Gate.tsx";
import { Inbox } from "./components/Inbox.tsx";
import { Mail } from "./components/Mail.tsx";
import { MailCompose } from "./components/MailCompose.tsx";
import { Palette } from "./components/Palette.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Today } from "./components/Today.tsx";
import { Spinner } from "./components/common.tsx";
import { registerDrop } from "./lib/drag.ts";
import { acceptsUpload } from "./lib/status.ts";
import { addToDraft, dismissToast, getState, navigate, setState, toast, useStore } from "./lib/store.ts";
import { plural } from "./lib/util.ts";

export function App() {
  const phase = useStore((s) => s.phase);
  if (phase === "boot")
    return (
      <div className="gate">
        <Spinner size={20} />
      </div>
    );
  if (phase === "setup") return <Setup />;
  if (phase === "locked") return <LockScreen />;
  return <Shell />;
}

function Shell() {
  const route = useStore((s) => s.route);
  const palette = useStore((s) => s.paletteOpen);
  const compose = useStore((s) => s.compose);
  const mailCompose = useStore((s) => s.mailCompose);
  const sideOpen = useStore((s) => s.sideOpen);

  // Dropping files on an assignment (row or submit box) stages them for it.
  useEffect(() => {
    const stage = (parts: string[], files: Parameters<typeof addToDraft>[2]) => {
      const [courseId, assignmentId] = parts.map(Number);
      const a = getState().dash?.assignments.find((x) => x.id === assignmentId && x.course_id === courseId);
      if (!a) return;
      if (!acceptsUpload(a)) return toast(`“${a.name}” doesn't take file uploads.`, "info");
      addToDraft(courseId, assignmentId, files);
      navigate({ view: "course", courseId, assignmentId });
      toast(`${plural(files.length, "file")} added to “${a.name}”. Check the list, then Submit.`, "info");
    };
    const offs = [registerDrop("asg", stage), registerDrop("submit", stage)];
    return () => offs.forEach((f) => f());
  }, []);

  return (
    <div className={`app${sideOpen ? " side-open" : ""}`}>
      <Sidebar />
      {sideOpen && <div className="side-scrim" onClick={() => setState({ sideOpen: false })} />}
      <main className="main">
        {route.view === "today" && <Today />}
        {route.view === "course" && <CourseView courseId={route.courseId} assignmentId={route.assignmentId} />}
        {route.view === "inbox" && <Inbox conversationId={route.conversationId} />}
        {route.view === "mail" && <Mail threadId={route.threadId} />}
        {route.view === "settings" && <Settings />}
        {route.view === "dates" && <KeyDates />}
      </main>
      {palette && <Palette />}
      {compose && <Compose init={compose} />}
      {mailCompose && <MailCompose init={mailCompose} />}
      <DragLayer />
      <Confetti />
      <Toasts />
    </div>
  );
}

function DragLayer() {
  const drag = useStore((s) => s.drag);
  if (!drag) return null;
  if (drag.source === "os") return <div className="os-drop" />;
  return (
    <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
      <FileText size={14} />
      {drag.files.length === 1 ? drag.files[0].name : plural(drag.files.length, "file")}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
          <div className="tt">{t.text}</div>
          {t.action && (
            <button
              className="btn btn-sm"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
