import { ArrowUp, ChevronDown, ChevronUp, Copy, FolderOpen, FolderSearch, Link, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { beginFileDrag } from "../lib/drag.ts";
import { acceptsUpload } from "../lib/status.ts";
import { addToDraft, reportError, setState, toast, useStore } from "../lib/store.ts";
import { fmtListTime, fmtSize } from "../lib/time.ts";
import type { Assignment, Course, Entry, FileRef } from "../lib/types.ts";
import { copyText, fuzzyScore, plural } from "../lib/util.ts";
import { Empty, FileIcon, Spinner } from "./common.tsx";
import { entryToPicked } from "./SubmitBox.tsx";

type SortKey = "name" | "modified" | "size";

export function FilesPane({ course, target }: { course: Course; target: Assignment | null }) {
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const version = useStore((s) => s.fileVersion[course.id] ?? 0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRel("");
    setSel(new Set());
  }, [course.id, course.folder]);

  useEffect(() => {
    if (!course.folder) return;
    let live = true;
    api
      .listDir(course.id, rel)
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setEntries(null);
        setError(e.message);
        if (rel) setRel(""); // folder vanished: go back to the top
      });
    return () => {
      live = false;
    };
  }, [course.id, course.folder, rel, version]);

  const shown = useMemo(() => {
    let list = entries ?? [];
    if (q.trim()) list = list.filter((e) => fuzzyScore(q, e.name) > 0);
    const dir = sort.desc ? -1 : 1;
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sort.key === "modified") return ((a.modifiedMs ?? 0) - (b.modifiedMs ?? 0)) * dir;
      if (sort.key === "size") return (a.size - b.size) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }, [entries, q, sort]);

  if (!course.folder) {
    return (
      <div className="panel">
        <div className="panel-head">
          <FolderOpen size={15} />
          <h2>Course folder</h2>
        </div>
        <Empty
          title="No folder linked"
          action={
            <button className="btn btn-primary" onClick={() => linkFolder(course)}>
              <Link size={14} /> Link a folder…
            </button>
          }
        >
          Link the folder where you keep this course's files. You'll see them here and can drag them onto assignments. Studydesk only reads it.
        </Empty>
      </div>
    );
  }

  const fileRef = (e: Entry): FileRef => ({ kind: "linked", courseId: course.id, rel: e.rel });
  const crumbs = rel ? rel.split("/") : [];
  const folderName = course.folder.split(/[\\/]/).filter(Boolean).pop() ?? course.folder;
  const selectedFiles = () => shown.filter((e) => !e.isDir && sel.has(e.rel));
  const canStage = target != null && acceptsUpload(target);

  const open = (e: Entry) => {
    if (e.isDir) {
      setRel(e.rel);
      setSel(new Set());
      setQ("");
    } else api.openFile(fileRef(e)).catch((err) => reportError(err));
  };

  const click = (ev: React.MouseEvent, e: Entry) => {
    if (ev.shiftKey && anchor) {
      const ia = shown.findIndex((x) => x.rel === anchor);
      const ib = shown.findIndex((x) => x.rel === e.rel);
      const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
      setSel(new Set(shown.slice(lo, hi + 1).map((x) => x.rel)));
    } else if (ev.ctrlKey || ev.metaKey) {
      const n = new Set(sel);
      n.has(e.rel) ? n.delete(e.rel) : n.add(e.rel);
      setSel(n);
      setAnchor(e.rel);
    } else {
      setSel(new Set([e.rel]));
      setAnchor(e.rel);
    }
  };

  const stage = (list: Entry[]) => {
    if (!target) return;
    addToDraft(target.course_id, target.id, list.map((e) => entryToPicked(course.id, e)));
    toast(`${plural(list.length, "file")} added to “${target.name}”. Review and submit in the details panel.`, "info");
  };

  const onKey = (ev: React.KeyboardEvent) => {
    const idx = shown.findIndex((x) => x.rel === anchor);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = shown[ev.key === "ArrowDown" ? Math.min(shown.length - 1, idx + 1) : Math.max(0, idx - 1)];
      if (n) {
        setSel(new Set([n.rel]));
        setAnchor(n.rel);
      }
    } else if (ev.key === "Enter" && shown[idx]) open(shown[idx]);
    else if (ev.key === "Backspace" && rel) setRel(crumbs.slice(0, -1).join("/"));
  };

  const SortHead = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => (
    <button className={right ? "r" : ""} onClick={() => setSort({ key: k, desc: sort.key === k ? !sort.desc : k !== "name" })}>
      {label}
      {sort.key === k && (sort.desc ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}
    </button>
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <FolderOpen size={15} />
        <h2 className="ellipsis" title={course.folder}>{folderName}</h2>
        <div className="right">
          <button className="icon-btn" title="Show in File Explorer" aria-label="Show in File Explorer" onClick={() => api.revealFile({ kind: "linked", courseId: course.id, rel }).catch((e) => reportError(e))}>
            <FolderSearch size={15} />
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => linkFolder(course)}>
            Change…
          </button>
        </div>
      </div>
      <div className="toolbar">
        <button className="icon-btn" disabled={!rel} onClick={() => setRel(crumbs.slice(0, -1).join("/"))} title="Up one folder (Backspace)" aria-label="Up one folder (Backspace)">
          <ArrowUp size={15} />
        </button>
        <div className="search">
          <Search size={14} />
          <input className="input" placeholder="Filter this folder" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {canStage && sel.size > 0 && selectedFiles().length > 0 && (
          <button className="btn btn-sm btn-primary" onClick={() => stage(selectedFiles())} title={`Add to ${target!.name}`}>
            <Upload size={13} /> Add {selectedFiles().length} to submission
          </button>
        )}
      </div>
      {crumbs.length > 0 && (
        <div className="crumbs">
          <button onClick={() => setRel("")}>{folderName}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="row-flex" style={{ gap: 2 }}>
              <span className="muted">/</span>
              <button onClick={() => setRel(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
            </span>
          ))}
        </div>
      )}
      <div className="scroll" ref={ref} tabIndex={0} onKeyDown={onKey} aria-label="Files">
        <div className="fhead">
          <SortHead k="name" label="Name" />
          <SortHead k="modified" label="Modified" right />
          <SortHead k="size" label="Size" right />
        </div>
        {error ? (
          <Empty title="Can't read this folder">{error}</Empty>
        ) : entries == null ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : shown.length === 0 ? (
          <Empty title={q ? "No matches" : "This folder is empty"} />
        ) : (
          shown.map((e) => (
            <div
              key={e.rel}
              className={`frow${sel.has(e.rel) ? " selected" : ""}`}
              onClick={(ev) => click(ev, e)}
              onDoubleClick={() => open(e)}
              onPointerDown={(ev) => {
                if (e.isDir || (ev.target as HTMLElement).closest("button")) return;
                beginFileDrag(ev, () => {
                  const list = sel.has(e.rel) ? selectedFiles() : [e];
                  return list.map((x) => entryToPicked(course.id, x));
                });
              }}
              title={e.isDir ? "Double-click to open" : "Double-click to open · drag onto an assignment to submit"}
            >
              <div className="fname">
                <FileIcon ext={e.ext} dir={e.isDir} />
                <span className="ellipsis">{e.name}</span>
                {!e.isDir && e.ext && <span className="ext">{e.ext}</span>}
                <span className="acts" style={{ marginLeft: "auto" }}>
                  {!e.isDir && canStage && (
                    <button className="icon-btn sm" title={`Add to “${target!.name}”`} aria-label={`Add to “${target!.name}”`} onClick={(ev) => (ev.stopPropagation(), stage([e]))}>
                      <Upload size={13} />
                    </button>
                  )}
                  <button className="icon-btn sm" title="Show in File Explorer" aria-label="Show in File Explorer" onClick={(ev) => (ev.stopPropagation(), api.revealFile(fileRef(e)).catch((er) => reportError(er)))}>
                    <FolderSearch size={13} />
                  </button>
                  <button
                    className="icon-btn sm"
                    title="Copy full path"
                    aria-label="Copy full path"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      api
                        .filePath(fileRef(e))
                        .then(copyText)
                        .then((ok) => toast(ok ? "Path copied." : "Couldn't copy.", ok ? "ok" : "error"))
                        .catch((er) => reportError(er));
                    }}
                  >
                    <Copy size={13} />
                  </button>
                </span>
              </div>
              <div className="r">{e.modifiedMs ? fmtListTime(e.modifiedMs) : ""}</div>
              <div className="r">{e.isDir ? "" : fmtSize(e.size)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export async function linkFolder(course: Course) {
  try {
    const p = await api.linkFolder(course.id, course.course_code || course.name);
    if (p) {
      setState((s) => ({
        dash: s.dash ? { ...s.dash, courses: s.dash.courses.map((c) => (c.id === course.id ? { ...c, folder: p } : c)) } : s.dash,
      }));
      toast(`Linked ${p}`, "ok");
    }
  } catch (e) {
    reportError(e);
  }
}
