// GitHub REST client for the JARVIS / A.R.A. build pipeline.
//
// JARVIS (or A.R.A. for a client project) files an issue with "@claude <spec>";
// the Claude Code GitHub Action implements it on a branch, opens a PR, and
// comments. This module is the app's side: create a project repo, file the
// request, read the conversation, answer questions, find the PR, and merge it
// once Mr. Burrus has confirmed. Everything runs only while the app is open.
//
// Every function takes a `repo` ({owner, repo}); it defaults to Empire OS V2, so
// app-change builds are unaffected. Client projects pass their own repo.
import{loadGitHubToken}from './keyStore';
import{encryptSecret}from './githubSecrets';

export const DEFAULT_REPO={owner:'lulrell37',repo:'lulrell37-Empire-OS-V2'};
export const REPO=DEFAULT_REPO; // back-compat
export const TEMPLATE_REPO={owner:'lulrell37',repo:'client-project-template'};
const API='https://api.github.com';
const rp=(repo)=>`/repos/${repo.owner}/${repo.repo}`;

// The Action posts as the github-actions bot (and, with a custom app, claude).
const CLAUDE_AUTHORS=['github-actions[bot]','claude[bot]','claude'];
export function isClaudeAuthor(login){return CLAUDE_AUTHORS.includes(String(login||'').toLowerCase());}

async function gh(path,{method='GET',body,raw=false}={}){
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
    throw Object.assign(new Error(`GitHub: ${String(msg).slice(0,180)}`),{status:res.status});
  }
  return raw?{status:res.status,json}:json;
}

// --- Connection check for the Settings status line ---
export async function ghVerify(repo=DEFAULT_REPO){
  try{
    const r=await gh(rp(repo));
    return{ok:true,repo:r.full_name,private:r.private,permissions:r.permissions};
  }catch(e){
    return{ok:false,error:e.message,noToken:!!e.noToken};
  }
}

// --- Create a dedicated repo for a client project ---------------------------
// Generates a new private repo from the client-project-template, then wires the
// ANTHROPIC_API_KEY secret and PR permissions so the Claude Code Action can run.
export function slugifyRepoName(name){
  const base=String(name||'project').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'project';
  return `client-${base}`;
}

async function ghMe(){
  try{const u=await gh('/user');return u?.login||null;}catch{return null;}
}

// Poll until the just-generated repo answers (generate is briefly async).
async function waitForRepo(owner,repo,tries=10){
  for(let i=0;i<tries;i++){
    try{await gh(`/repos/${owner}/${repo}`);return true;}catch(e){if(e.status!==404)throw e;}
    await new Promise(r=>setTimeout(r,1500));
  }
  return false;
}

export async function setRepoSecret(repo,name,value){
  const pk=await gh(`${rp(repo)}/actions/secrets/public-key`);
  const encrypted_value=encryptSecret(pk.key,value);
  await gh(`${rp(repo)}/actions/secrets/${name}`,{method:'PUT',body:{encrypted_value,key_id:pk.key_id}});
}

// Returns {owner, repo, url, warnings[]}. Throws only if the repo itself can't
// be created; secret / permission failures come back as warnings so A.R.A. can
// tell Mr. Burrus what to finish by hand.
export async function createProjectRepo(projectName,{anthropicKey}={}){
  const owner=await ghMe();
  if(!owner)throw new Error("Couldn't read your GitHub account — check the token in Settings › Dev.");
  let name=slugifyRepoName(projectName);
  const warnings=[];

  // Name collision — suffix with a short number.
  for(let n=0;n<20;n++){
    try{await gh(`/repos/${owner}/${n?`${name}-${n+1}`:name}`);}
    catch(e){if(e.status===404){if(n)name=`${name}-${n+1}`;break;}throw e;}
    if(n===19)name=`${name}-${Date.now().toString().slice(-4)}`;
  }

  const created=await gh(`${rp(TEMPLATE_REPO)}/generate`,{method:'POST',body:{
    owner,name,private:true,
    description:`Client project — ${String(projectName||'').slice(0,120)} · scaffolded by Empire OS / The Firm`,
  }});
  const repo={owner,repo:created.name||name};
  await waitForRepo(repo.owner,repo.repo);

  if(anthropicKey){
    try{await setRepoSecret(repo,'ANTHROPIC_API_KEY',anthropicKey);}
    catch(e){warnings.push(`Couldn't set ANTHROPIC_API_KEY secret (${e.message}). Add it in the repo's Settings › Secrets before the first build.`);}
  }else{
    warnings.push('No Anthropic key on file — add ANTHROPIC_API_KEY to the new repo before the first build.');
  }

  try{
    await gh(`${rp(repo)}/actions/permissions/workflow`,{method:'PUT',body:{
      default_workflow_permissions:'write',can_approve_pull_request_reviews:true,
    }});
  }catch(e){warnings.push(`Couldn't enable PR permissions (${e.message}). Turn on "Allow GitHub Actions to create and approve pull requests" in the repo's Actions settings.`);}

  return{owner:repo.owner,repo:repo.repo,url:created.html_url||`https://github.com/${repo.owner}/${repo.repo}`,warnings};
}

// --- File a build request ---
export async function fileBuildRequest(spec,repo=DEFAULT_REPO){
  const clean=String(spec||'').trim();
  if(!clean)throw new Error('Empty build request.');
  const firstLine=clean.split('\n')[0].trim();
  const title=firstLine.length>90?firstLine.slice(0,87)+'…':firstLine;
  const issue=await gh(`${rp(repo)}/issues`,{method:'POST',body:{
    title:title||'Build request from Empire OS',
    body:`@claude\n\n${clean}\n\nImplement this on a branch and open a pull request that closes this issue. If anything is ambiguous, ask here before writing code.\n\n<!-- filed by Empire OS -->`,
  }});
  return{issueNumber:issue.number,url:issue.html_url,title:issue.title};
}

// --- Read new comments since a known id ---
export async function getIssueActivity(issueNumber,sinceCommentId=0,repo=DEFAULT_REPO){
  const comments=await gh(`${rp(repo)}/issues/${issueNumber}/comments?per_page=100`);
  return comments
    .filter(c=>c.id>(sinceCommentId||0))
    .map(c=>({id:c.id,author:c.user?.login||'',body:c.body||'',isClaude:isClaudeAuthor(c.user?.login)}));
}

// --- Answer a pending question ---
export async function replyToBuild(issueNumber,text,repo=DEFAULT_REPO){
  const t=String(text||'').trim();
  if(!t)throw new Error('Empty reply.');
  await gh(`${rp(repo)}/issues/${issueNumber}/comments`,{method:'POST',body:{body:`@claude ${t}`}});
  return{ok:true};
}

// --- Find the PR the Action opened for this issue ---
export async function findLinkedPR(issueNumber,repo=DEFAULT_REPO){
  const prs=await gh(`${rp(repo)}/pulls?state=all&per_page=50&sort=created&direction=desc`);
  const branchTag=`issue-${issueNumber}-`;
  const pr=prs.find(p=>
    String(p.head?.ref||'').includes(branchTag)||
    (p.body||'').includes(`#${issueNumber}`)
  );
  if(!pr)return null;
  return{prNumber:pr.number,title:pr.title,state:pr.state,merged:!!pr.merged_at,url:pr.html_url,headSha:pr.head?.sha};
}

// --- PR + CI status ---
export async function getPRStatus(prNumber,repo=DEFAULT_REPO){
  const pr=await gh(`${rp(repo)}/pulls/${prNumber}`);
  let checks='none';
  if(pr.head?.sha){
    try{
      const cr=await gh(`${rp(repo)}/commits/${pr.head.sha}/check-runs?per_page=100`);
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
export async function mergeBuild(prNumber,repo=DEFAULT_REPO){
  const res=await gh(`${rp(repo)}/pulls/${prNumber}/merge`,{method:'PUT',body:{merge_method:'squash'}});
  return{merged:!!res.merged,sha:res.sha};
}

// --- Abandon a request ---
export async function cancelBuild(issueNumber,prNumber,repo=DEFAULT_REPO){
  if(prNumber){try{await gh(`${rp(repo)}/pulls/${prNumber}`,{method:'PATCH',body:{state:'closed'}});}catch{}}
  try{await gh(`${rp(repo)}/issues/${issueNumber}`,{method:'PATCH',body:{state:'closed'}});}catch{}
  return{ok:true};
}
