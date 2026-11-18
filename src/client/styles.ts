export const styles = `.ad-root {
  max-width: 1320px;
  margin: auto;
  padding: 24px;
  color: var(--foreground, #dce3ef);
  font: 14px/1.6 system-ui, sans-serif;
}
.ad-root * { box-sizing: border-box; }
.ad-root header, .ad-actions, .ad-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.ad-root header { justify-content: space-between; }
.ad-root h1 { font-size: 28px; margin: 0; }
.ad-root h2 { font-size: 17px; margin: 0 0 12px; }
.ad-eyebrow { font-size: 11px; letter-spacing: .12em; color: #9aaac0; margin: 0; }
.ad-badge { background: #233849; color: #a1d5ef; padding: 5px 12px; border-radius: 24px; }
.ad-start { border-color: #5789af; }
.ad-start blockquote { margin: 12px 0; padding: 10px 14px; border-left: 3px solid #5789af; background: rgba(124,144,170,.08); }
.ad-overview { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; }
.ad-overview dt { color: #99a8bb; }
.ad-overview dd { margin: 0; overflow-wrap: anywhere; }
.ad-fold > summary { cursor: pointer; font-weight: 600; }
.ad-fold[open] > summary { margin-bottom: 10px; }
.ad-evidence { margin: 10px 0; }
.ad-card {
  min-width: 0;
  background: var(--background-secondary, rgba(124,144,170,.065));
  border: 1px solid rgba(140,160,190,.25);
  border-radius: 12px;
  padding: 20px;
  margin: 16px 0;
}
.ad-root label { display: flex; flex-direction: column; gap: 5px; margin: 12px 0; flex: 1; min-width: 0; }
.ad-root input, .ad-root select, .ad-root textarea {
  font: inherit;
  color: inherit;
  background: var(--background, #151d29);
  border: 1px solid #536176;
  border-radius: 6px;
  padding: 8px;
  width: 100%;
  min-width: 0;
}
.ad-root textarea { font-family: ui-monospace, monospace; resize: vertical; }
.ad-root button { font: inherit; background: var(--background, #202c3c); color: inherit; border: 1px solid #52617a; padding: 7px 12px; border-radius: 6px; cursor: pointer; }
.ad-root button:hover:not(:disabled) { border-color: #80c9f0; }
.ad-root :focus-visible { outline: 2px solid #8cc9ff; outline-offset: 3px; }
.ad-root button:disabled { opacity: .45; cursor: not-allowed; }
.ad-root .ad-primary { background: #285a7e; border-color: #5789af; }
.ad-root pre {
  font: 12px/1.7 ui-monospace, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: rgba(0,0,0,.16);
  padding: 12px;
  border-radius: 6px;
  max-height: 420px;
  overflow: auto;
}
.ad-hint { color: #99a8bb; font-size: 12px; overflow-wrap: anywhere; }
.ad-warning { padding: 12px; border-left: 3px solid #e9b868; background: rgba(233,184,104,.1); overflow-wrap: anywhere; }
.ad-preview { border-color: #628eb5; }
.ad-root .ad-check { flex-direction: row; align-items: flex-start; }
.ad-check input { width: auto; margin-top: 6px; }
.ad-stack li { padding: 6px; overflow-wrap: anywhere; }
.ad-stack span { display: block; color: #99a8bb; }
@media (max-width: 800px) {
  .ad-root { padding: 12px; }
  .ad-card { padding: 14px; }
}
`;
