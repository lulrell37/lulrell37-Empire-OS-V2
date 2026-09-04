# R.O.G.U.E. clip-edit agent — scheduled routine

R.O.G.U.E. queues clip edits from the Empire OS app by filing a GitHub issue
labelled **`rogue-clip`** on `lulrell37/lulrell37-Empire-OS-V2`. This routine is
the other half: it picks those issues up, runs the edit in Descript, and reports
the finished link back on the issue. The app polls the issue and shows the result
in R.O.G.U.E.'s CLIPS panel.

## Requirements

- **GitHub**: the routine needs `gh` CLI auth (or a PAT) with `repo` scope on
  `lulrell37/lulrell37-Empire-OS-V2` — enough to read issues and post comments.
- **Descript**: the Descript integration must be connected to the Claude account
  the routine runs under (drive: *Lul Rell's Drive*).

## Schedule

**Hourly** (`0 * * * *`). Cloud routines can't run more often than once an hour.
For a rush job, hit "Run now" on the routine at https://claude.ai/code/routines.

## Routine prompt

```
You are the clip-edit worker for R.O.G.U.E.

1. List open clip jobs:
   gh issue list -R lulrell37/lulrell37-Empire-OS-V2 --label rogue-clip --state open --json number,title,body,comments

2. For each issue:
   a. If its comments already contain "<!-- clip-status: editing -->", skip it — it's in progress or stuck; leave it.
   b. Parse the job from the body: the line "<!-- clip-job: {...} -->" is JSON with { "media_url", "instructions" }.
   c. Post a comment on the issue:
        <!-- clip-status: editing -->
        On it — importing the clip and editing in Descript now.
   d. Descript:
        - media_url from the app is a direct Drive download link
          (https://drive.google.com/uc?export=download&id=<ID>). import_media with it.
        - If import fails on a Drive link (Google interstitial on a large file):
          use the Google-Drive connector to fetch the file locally by its <ID>,
          then import_media by direct file upload.
        - A plain YouTube/TikTok/etc URL: import_media with it directly.
        - → note the project id
        - prompt_project_agent on that project with the instructions, plus:
          "Deliver a vertical 9:16 short unless the brief says otherwise. Add clean captions. Keep it tight."
        - wait_for_job until it finishes
        - publish_project on the project → get the share URL and the download URL
   e. Post a comment on the issue:
        <!-- clip-result: {"download":"<DOWNLOAD_URL>","share":"<SHARE_URL>"} -->
        ✂️ Done — [download](<DOWNLOAD_URL>) · [watch](<SHARE_URL>)
      Then close the issue:  gh issue close <number> -R lulrell37/lulrell37-Empire-OS-V2

3. If anything fails for an issue, post:
        <!-- clip-failed: <one-line reason> -->
        Couldn't finish this one — <reason>.
   and close the issue. Move on to the next.

Do not touch issues without the rogue-clip label. Do not open new issues.
```

## Markers the app reads

| Comment marker | App does |
| --- | --- |
| `<!-- clip-status: editing -->` | job → EDITING |
| `<!-- clip-result: {"download","share"} -->` | job → DONE, shows Download / Watch |
| `<!-- clip-failed: reason -->` | job → FAILED, shows the reason |
| issue closed, no result marker | job → CANCELLED |
