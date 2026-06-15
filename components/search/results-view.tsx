// Copyright (c) 2026 Benjamin Lau
// SPDX-License-Identifier: MIT

"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { formatMimeType } from "@/lib/file-types";
import type { DriveFile, QuerySession } from "@/hooks/use-query-sessions";
import { downloadAnswer } from "./format";
import { AnswerView, FileList } from "./result-views";

export function ResultsView({
  activeSession,
  uniqueFiles,
  touchedFiles,
  reviewingFiles,
  progressOpen,
  setProgressOpen
}: {
  activeSession: QuerySession | null;
  uniqueFiles: DriveFile[];
  touchedFiles: DriveFile[];
  reviewingFiles: DriveFile[];
  progressOpen: boolean;
  setProgressOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [touchedOpen, setTouchedOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(true);

  // The live "thinking" stream.
  const reasoning = activeSession?.reasoning ?? "";
  const status = activeSession?.status;
  // Mirror the Progress drawer: expand the thinking while a run is active and
  // collapse it once the answer is complete. Only runs on a status change, so a
  // manual re-expand sticks; left untouched on error so the last thoughts stay
  // visible for debugging.
  useEffect(() => {
    if (status === "running") setThinkingOpen(true);
    else if (status === "finished") setThinkingOpen(false);
  }, [status]);
  const thinkingRef = useRef<HTMLDivElement>(null);
  // On (re)open, jump to the latest reasoning.
  useEffect(() => {
    const el = thinkingRef.current;
    if (thinkingOpen && el) el.scrollTop = el.scrollHeight;
  }, [thinkingOpen]);
  // On new reasoning, follow the bottom ONLY if the user is already near it, so
  // scrolling up to re-read earlier thoughts isn't yanked back down on every delta.
  useEffect(() => {
    const el = thinkingRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 40) el.scrollTop = el.scrollHeight;
  }, [reasoning]);

  const isSynthesis = activeSession?.mode === "synthesis";
  const isUncuratedList = activeSession?.mode === "list" && !activeSession.curateList;
  // Synthesis shows the files the answer cites ("Sources"); list modes show the
  // matched/kept files ("Files").
  const primaryFilesLabel = isSynthesis ? "Sources" : "Files";
  // The "files touched" audit set equals the result list in uncurated mode (there
  // every match is a result), so only disclose it where it adds signal.
  const showTouched = touchedFiles.length > 0 && !isUncuratedList;

  return (
    <>
      {(activeSession?.events.length ?? 0) > 0 ? (
        <section className="panel progress-panel">
          <div className="panel-header">
            <h2>Progress</h2>
            <button
              className="progress-toggle"
              type="button"
              aria-expanded={progressOpen}
              onClick={() => setProgressOpen((open) => !open)}
            >
              {progressOpen ? "Hide" : "Show"}
              <span className="muted">({activeSession?.events.length ?? 0})</span>
            </button>
          </div>
          {progressOpen ? (
            <div className="panel-body stream">
              {activeSession?.events.map((event, index) => (
                <div className="stream-line" key={`${event}-${index}`}>
                  {event}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {reasoning ? (
        <section className="panel thinking-panel">
          <div className="panel-header">
            <h2>Thinking</h2>
            <button
              className="progress-toggle"
              type="button"
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((open) => !open)}
            >
              {thinkingOpen ? "Hide" : "Show"}
            </button>
          </div>
          {thinkingOpen ? (
            <div className="panel-body">
              <p className="panel-subtitle">
                Live reasoning from the agent. Shown as plain text and not used as a result.
              </p>
              <div className="thinking-stream" ref={thinkingRef} aria-live="polite">
                {reasoning}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeSession?.mode === "synthesis" && activeSession.answer ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Answer</h2>
            <button
              className="download-button"
              type="button"
              onClick={() =>
                downloadAnswer(activeSession.answer, activeSession.answerFormat, activeSession.query)
              }
            >
              Download
            </button>
          </div>
          <div className="panel-body">
            <AnswerView answer={activeSession.answer} format={activeSession.answerFormat} />
          </div>
        </section>
      ) : null}

      {uniqueFiles.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>{primaryFilesLabel}</h2>
            {isSynthesis ? <p className="panel-subtitle">Files the answer cites.</p> : null}
          </div>
          <div className="panel-body">
            <FileList files={uniqueFiles} />
          </div>
        </section>
      ) : null}

      {showTouched ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Files touched</h2>
            <button
              className="progress-toggle"
              type="button"
              aria-expanded={touchedOpen}
              onClick={() => setTouchedOpen((open) => !open)}
            >
              {touchedOpen ? "Hide" : "Show"}
              <span className="muted">({touchedFiles.length})</span>
            </button>
          </div>
          {touchedOpen ? (
            <div className="panel-body">
              <p className="panel-subtitle">
                Every file the agent searched, opened, or reviewed this run. The{" "}
                {primaryFilesLabel.toLowerCase()} above are the subset it relied on.
              </p>
              <FileList files={touchedFiles} />
            </div>
          ) : null}
        </section>
      ) : null}

      {reviewingFiles.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Reviewing</h2>
            <p className="panel-subtitle">
              Files the agent is reading and grading right now. Only the ones judged relevant are
              kept above.
            </p>
          </div>
          <div className="panel-body">
            <ul className="file-list">
              {reviewingFiles.map((file) => (
                <li className="file-card reviewing" key={`${file.connectionId}:${file.id}`}>
                  <span className="reviewing-badge">Reviewing</span>
                  {file.webViewLink ? (
                    <a href={file.webViewLink} target="_blank" rel="noreferrer">
                      {file.name}
                    </a>
                  ) : (
                    <strong>{file.name}</strong>
                  )}
                  <span className="muted">Drive account: {file.driveEmail}</span>
                  <span className="muted">Type: {formatMimeType(file.mimeType)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  );
}
