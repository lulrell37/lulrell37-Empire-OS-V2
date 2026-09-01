// GitHub REST client for the JARVIS build pipeline.
//
// JARVIS files an issue with "@claude <spec>"; the Claude Code GitHub Action
// (.github/workflows/claude.yml) implements it on a branch, opens a PR, and
// comments. This module is the app's side: file the request, read the
// conversation, answer questions, find the PR, and merge it once Mr. Burrus has
// confirmed. Everything runs only while the app is open (assisted boundary).
import{loadGitHubToken}from './keyStore';

export const REPO={owner:'lulrell37',repo:'lulrell37-Empire-OS-V2'};
const API='https://api.github.com';
const R=`/repos/${REPO.owner}/${REPO.repo}`;

// The Action posts as the github-actions bot (and, with a custom app, claude).
const CLAUDE_AUTHORS=['github-actions[bot]','claude[bot]','claude'];
export function isClaudeAuthor(login){return CLAUDE_AUTHORS.includes(String(login||'').toLowerCase());}

async function gh(path,{method='GET',body}={}){
  const token=await loadGitHubToken();
  if(!token)throw Object.assign(new Error('GitHub not connected. Add a token in Settings › Dev.'),{noToken:true});
  const res=await fetch(API+path,{
    method,
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      ...(body?{'Content-Type':'application/json'}:{}),
    },
    body:body?JSON.stringify(body):undefined,
  });
  const text=await res.text();
  let json;try{json=text?JSON.parse(text):{};}catch{json={raw:text};}
  if(!res.ok){
    const msg=json?.message||text||`HTTP ${res.status}`;
    throw Object.assign(new Error(`GitHub: ${String(msg).slice(0,160)}`),{status:res.status});
  }
  return json;
}

// --- Connection check for the Settings status line ---
export async function ghVerify(){
  try{
    const repo=await gh(R);
    return{ok:true,repo:repo.full_name,private:repo.private,permissions:repo.permissions};
  }catch(e){
    return{ok:false,error:e.message,noToken:!!e.noToken};
  }
}

// --- File a build request ---
export async function fileBuildRequest(spec){
  const clean=String(spec||'').trim();
  if(!clean)throw new Error('Empty build request.');
  const firstLine=clean.split('\n')[0].trim();
  const title=firstLine.length>90?firstLine.slice(0,87)+'…':firstLine;
  const issue=await gh(`${R}/issues`,{method:'POST',body:{
    title:title||'Build request from JARVIS',
    body:`@claude\n\n${clean}\n\nImplement this on a branch and open a pull request that closes this issue. If anything is ambiguous, ask here before writing code.\n\n<!-- filed by JARVIS -->`,
  }});
  return{issueNumber:issue.number,url:issue.html_url,title:issue.title};
}

// --- Read new comments since a known id ---
export async function getIssueActivity(issueNumber,sinceCommentId=0){
  const comments=await gh(`${R}/issues/${issueNumber}/comments?per_page=100`);
  return comments
    .filter(c=>c.id>(sinceCommentId||0))
    .map(c=>({id:c.id,author:c.user?.login||'',body:c.body||'',isClaude:isClaudeAuthor(c.user?.login)}));
}

// --- Answer a pending question ---
export async function replyToBuild(issueNumber,text){
  const t=String(text||'').trim();
  if(!t)throw new Error('Empty reply.');
  await gh(`${R}/issues/${issueNumber}/comments`,{method:'POST',body:{body:`@claude ${t}`}});
  return{ok:true};
}

// --- Find the PR the Action opened for this issue ---
export async function findLinkedPR(issueNumber){
  const prs=await gh(`${R}/pulls?state=all&per_page=50&sort=created&direction=desc`);
  const branchTag=`issue-${issueNumber}-`;
  const pr=prs.find(p=>
    String(p.head?.ref||'').includes(branchTag)||
    (p.body||'').includes(`#${issueNumber}`)
  );
  if(!pr)return null;
  return{prNumber:pr.number,title:pr.title,state:pr.state,merged:!!pr.merged_at,url:pr.html_url,headSha:pr.head?.sha};
}

// --- PR + CI status ---
export async function getPRStatus(prNumber){
  const pr=await gh(`${R}/pulls/${prNumber}`);
  let checks='none';
  if(pr.head?.sha){
    try{
      const cr=await gh(`${R}/commits/${pr.head.sha}/check-runs?per_page=100`);
      const runs=cr.check_runs||[];
      if(runs.length){
        if(runs.some(r=>r.status!=='completed'))checks='pending';
        else if(runs.some(r=>['failure','timed_out','cancelled'].includes(r.conclusion)))checks='fail';
        else checks='pass';
      }
    }catch{/* checks are best-effort */}
  }
  return{
    prNumber,title:pr.title,state:pr.state,merged:!!pr.merged,
    mergeable:pr.mergeable,mergeableState:pr.mergeable_state,checks,url:pr.html_url,
  };
}

// --- Merge (called only after an in-app confirm) ---
export async function mergeBuild(prNumber){
  const res=await gh(`${R}/pulls/${prNumber}/merge`,{method:'PUT',body:{merge_method:'squash'}});
  return{merged:!!res.merged,sha:res.sha};
}

// --- Abandon a request ---
export async function cancelBuild(issueNumber,prNumber){
  if(prNumber){try{await gh(`${R}/pulls/${prNumber}`,{method:'PATCH',body:{state:'closed'}});}catch{}}
  try{await gh(`${R}/issues/${issueNumber}`,{method:'PATCH',body:{state:'closed'}});}catch{}
  return{ok:true};
}
