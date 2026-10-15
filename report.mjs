import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {itemStatus,statusLabels,reviewCounts} from './public/review-model.js';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export async function reviewReport(record, directory) {
  const counts=reviewCounts(record),h=escapeHTML;
  const findings=await Promise.all(record.issues.map(async issue=>{
    let evidence='';
    if(/^[a-f0-9-]{36}\.png$/.test(issue.screenshot || '')){
      const image=await readFile(path.join(directory,'screenshots',issue.screenshot)).catch(()=>null);
      evidence=image?`<img alt="Screenshot evidence" src="data:image/png;base64,${image.toString('base64')}">`:'<p>Screenshot file is unavailable.</p>';
    }
    return `<article><h3>${h(issue.status)} · ${h(issue.scenario)}</h3><p><b>Expected:</b> ${h(issue.expected)}</p><p><b>Observed:</b> ${h(issue.actual)}</p><p class="meta">${h(issue.side)} · ${h(issue.commit)} · ${h(issue.location)}</p>${evidence}${issue.resolution?`<p><b>Retest:</b> ${h(issue.resolution)}</p>`:''}${issue.consoleErrors?.length?`<pre>${h(issue.consoleErrors.join('\n'))}</pre>`:''}</article>`;
  }));
  const items=record.manifest.scenarios.map((item,index)=>{
    const saved=record.items?.[item.id]||{};
    return `<article><h2>${index+1}. ${h(item.title)} <small>${h(statusLabels[itemStatus(record,item)])}</small></h2><p class="meta">${h(item.id)} · ${h(item.path)}</p><p>${h(item.description)}</p><p><b>Instructions:</b> ${h(item.instructions || 'Complete each check below.')}</p><p><b>Expected:</b> ${h(item.expected || item.steps.join(' '))}</p><ul>${item.steps.map((step,i)=>`<li>${record.checks[`${item.id}:${i}`]?'☑':'☐'} ${h(step)}</li>`).join('')}</ul>${saved.notes?`<p><b>Notes:</b> ${h(saved.notes)}</p>`:''}${saved.reason?`<p><b>Outcome reason:</b> ${h(saved.reason)}</p>`:''}</article>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Branch Review · ${h(record.title)}</title><style>body{font:15px/1.65 system-ui,sans-serif;color:#20302f;max-width:1000px;margin:40px auto;padding:0 24px}h1{line-height:1.2}h2{font-size:20px}small,.meta{font-size:12px;color:#617269;overflow-wrap:anywhere}article{border-top:1px solid #d5ded5;margin:28px 0;padding:18px 0;break-inside:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;border:1px solid #d5ded5}pre{white-space:pre-wrap;font-size:12px;background:#f5f7f3;padding:12px}li{list-style:none;margin:8px 0}ul{padding:0}.summary{background:#edf3e9;padding:16px;border-radius:8px}@media print{body{margin:0}article{break-inside:auto}}</style></head><body><p class="meta">BRANCH REVIEW · LOCAL EVIDENCE REPORT</p><h1>${h(record.title)}</h1><p>${h(record.manifest.summary)}</p><p class="meta">Repository: ${h(record.identity.repository)}<br>Branch: ${h(record.identity.ref)}<br>Original: ${h(record.identity.base)}<br>Changed: ${h(record.identity.changed)}<br>Review ID: ${h(record.id)}<br>Last updated: ${h(record.updatedAt)}</p><div class="summary">${counts.passed} passed · ${counts['needs-fixes']} need fixes · ${counts.blocked} blocked · ${counts['not-applicable']} not applicable · ${counts['not-started']+counts['in-progress']} unfinished<p>Approval: ${record.approval?`${h(record.approval.reviewer)} at ${h(record.approval.at)}`:'Not approved'}<br>Delivery: ${h(record.delivery?.stage || 'Not delivered')}</p><small>Local review evidence is not proof of publication or hosted workflow acceptance.</small></div>${items.join('')}<h2>Findings and retests</h2>${findings.join('') || '<p>No findings recorded.</p>'}<h2>Activity</h2><ul>${record.events.map(event=>`<li class="meta">${h(event.at)} · ${h(event.type)}</li>`).join('')}</ul></body></html>`;
}
