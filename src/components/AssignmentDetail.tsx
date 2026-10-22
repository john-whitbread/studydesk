import { ExternalLink, MessageSquare, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { acceptsOnline, assignmentStatus, scoreLabel, typeLabel } from "../lib/status.ts";
import { reportError, setState, sync } from "../lib/store.ts";
import { fmtDateTime, fmtNum, fmtSize, parse, relative } from "../lib/time.ts";
import type { Assignment, AssignmentDetail as Detail, Course, RubricMark, Submission } from "../lib/types.ts";
import { Html, Linkified, Notice, Spinner, StatusChip } from "./common.tsx";
import { MyWork } from "./MyWork.tsx";
import { Receipt, SubmitBox, submitModes } from "./SubmitBox.tsx";

export function AssignmentDetail({ base, course, now, onClose }: { base: Assignment; course: Course; now: number; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<Submission | null>(null);
  const [resubmit, setResubmit] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return api
      .assignmentDetail(base.course_id, base.id)
      .then(setDetail)
      .catch((e) => reportError(e, "Couldn't load the assignment"))
      .finally(() => setLoading(false));
  }, [base.course_id, base.id]);

  useEffect(() => {
    setDetail(null);
    setReceipt(null);
    setResubmit(false);
    load();
  }, [load]);

  const a: Assignment = detail ? { ...detail.assignment, submission: detail.submission ?? detail.assignment.submission } : base;
  const sub = a.submission ?? null;
  const s = assignmentStatus(a, now);
  const due = parse(a.due_at);
  const unlock = parse(a.unlock_at);
  const lock = parse(a.lock_at);
  const used = sub?.attempt ?? 0;
  const allowed = a.allowed_attempts != null && a.allowed_attempts > 0 ? a.allowed_attempts : null;
  const modes = submitModes(a);
  const submittedAt = parse(sub?.submitted_at);
  const score = scoreLabel(a);
  const comments = sub?.submission_comments ?? [];
  const rubricMarks = (sub?.rubric_assessment ?? {}) as Record<string, RubricMark>;

  return (
    <div className="panel">
      <div className="panel-head">
        <StatusChip s={s} />
        <div className="right">
          {loading && <Spinner />}
          <button className="btn btn-sm btn-ghost" onClick={() => setState({ compose: { courseId: course.id, subject: `Question about: ${a.name}`, teachers: true } })}>
            <MessageSquare size={14} /> Ask instructor
          </button>
          {a.html_url && (
            <button className="btn btn-sm btn-ghost" onClick={() => api.openInCanvas(a.html_url as string).catch((e) => reportError(e))}>
              <ExternalLink size={14} /> Canvas
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close details" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="scroll">
        <div className="panel-body stack">
          <h2 className="detail-title selectable">{a.name}</h2>

          <dl className="facts">
            <dt>Due</dt>
            <dd>
              {due != null ? (
                <>
                  {fmtDateTime(due, now)} <span className={s.late && s.needsAction ? "text-danger" : "muted"}>· {relative(due, now)}</span>
                </>
              ) : (
                <span className="muted">No due date</span>
              )}
            </dd>
            {(unlock != null || lock != null) && (
              <>
                <dt>Available</dt>
                <dd>
                  {unlock != null && <>from {fmtDateTime(unlock, now)} </>}
                  {lock != null && <>until {fmtDateTime(lock, now)}</>}
                </dd>
              </>
            )}
            <dt>Points</dt>
            <dd>{a.points_possible != null ? fmtNum(a.points_possible) : <span className="muted">Not graded</span>}</dd>
            <dt>Submit as</dt>
            <dd>{a.submission_types.length ? a.submission_types.map(typeLabel).join(", ") : "—"}</dd>
            {a.submission_types.includes("online_upload") && (
              <>
                <dt>File types</dt>
                <dd>{a.allowed_extensions.length ? a.allowed_extensions.map((e) => `.${e.replace(/^\./, "").toLowerCase()}`).join(", ") : "Any"}</dd>
              </>
            )}
            {acceptsOnline(a) && (
              <>
                <dt>Attempts</dt>
                <dd>{allowed ? `${used} of ${allowed} used` : `${used} used · unlimited`}</dd>
              </>
            )}
            {score && (
              <>
                <dt>Grade</dt>
                <dd>
                  <b>{score}</b>
                  {sub?.grade && score !== sub.grade ? <span className="muted"> · {sub.grade}</span> : null}
                </dd>
              </>
            )}
          </dl>

          {a.locked_for_user && a.lock_explanation && (
            <Notice tone="neutral">
              <Html html={a.lock_explanation} />
            </Notice>
          )}

          <MyWork a={a} course={course} now={now} described={!!detail} />

          {receipt && <Receipt s={receipt} />}

          {modes.length > 0 && submittedAt != null && !resubmit ? (
            <div className="row-flex">
              <button className="btn" disabled={allowed != null && used >= allowed} onClick={() => setResubmit(true)}>
                Submit a new attempt
              </button>
              <span className="small muted">{allowed != null && used >= allowed ? "All allowed attempts are used." : `This would be attempt ${used + 1}${allowed ? ` of ${allowed}` : ""}.`}</span>
            </div>
          ) : modes.length > 0 ? (
            <SubmitBox
              a={a}
              course={course}
              onSubmitted={(r) => {
                setReceipt(r);
                setResubmit(false);
                load();
                sync();
              }}
            />
          ) : acceptsOnline(a) ? (
            <Notice tone="info">
              This is submitted inside Canvas ({a.submission_types.map(typeLabel).join(", ").toLowerCase()}).{" "}
              {a.html_url && (
                <a href={a.html_url} onClick={(e) => e.preventDefault()}>
                  Open in Canvas
                </a>
              )}
            </Notice>
          ) : null}

          {submittedAt != null && (
            <section>
              <div className="section-title">Your submission</div>
              <div className="small">
                {fmtDateTime(submittedAt, now)}
                {sub?.attempt ? ` · attempt ${sub.attempt}` : ""}
                {sub?.late ? <span className="text-warn"> · late</span> : null}
              </div>
              {(sub?.attachments ?? []).length > 0 && (
                <div className="atts">
                  {sub!.attachments.map((f) => (
                    <button key={f.id} className="att" onClick={() => f.url && api.openExternal(f.url).catch((e) => reportError(e))} title="Download in your browser">
                      <Paperclip size={13} />
                      <span className="ellipsis">{f.display_name || f.filename}</span>
                      {f.size ? <span className="muted">{fmtSize(f.size)}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {(comments.length > 0 || a.rubric.length > 0) && (
            <section className="stack" style={{ gap: 8 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>{comments.length || Object.keys(rubricMarks).length ? "Feedback" : "Rubric"}</div>
              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <div className="who">
                    <b>{c.author_name ?? "Instructor"}</b>
                    <span className="muted">{c.created_at ? fmtDateTime(parse(c.created_at) as number, now) : ""}</span>
                  </div>
                  <div className="msg-body">
                    <Linkified text={c.comment ?? ""} />
                  </div>
                </div>
              ))}
              {a.rubric.length > 0 && (
                <table className="rubric">
                  <thead>
                    <tr>
                      <th>Criterion</th>
                      <th style={{ textAlign: "right" }}>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.rubric.map((r) => {
                      const m = rubricMarks[r.id];
                      const rating = r.ratings.find((x) => x.id && x.id === m?.rating_id);
                      return (
                        <tr key={r.id}>
                          <td>
                            <div>{r.description}</div>
                            {rating?.description && <div className="small dim">{rating.description}</div>}
                            {m?.comments && <div className="small muted">{m.comments}</div>}
                          </td>
                          <td className="pts">
                            {m?.points != null ? <b>{fmtNum(m.points)}</b> : <span className="muted">–</span>}
                            <span className="muted"> / {fmtNum(r.points ?? 0)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {a.description && (
            <section>
              <div className="section-title">Instructions</div>
              <Html html={a.description} clamp />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
