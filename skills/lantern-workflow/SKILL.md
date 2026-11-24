---
name: lantern-workflow
description: Use Lantern Harness MCP tools for requirement import, requirement breakdown, story review, test points, functional cases, UI automation projects and scripts, automation runs, defects and business-map updates. Use when an MCP-capable client or orchestrator needs to analyze, generate, automate, execute or update Lantern test assets.
---

# Lantern Workflow

Lantern is the source of truth for business execution, validation and persistence. The calling MCP client, model or orchestrator owns conversation and may perform pre-processing, post-processing or fallback reasoning. Codex is one supported client, not a protocol requirement.

## Routing

- “拆解这个需求” means: import or select the source, run requirement breakdown, save stories, then return a summary. Do not generate test points or test cases unless asked.
- “完整需求分析” means: breakdown, save stories, review stories, generate test points, then return the combined summary.
- “生成测试点” means: use existing saved stories and a Lantern test-point skill. Do not silently replace stories.
- “继续生成用例” or “完整测试设计” continues from the saved requirement analysis.
- “生成功能测试用例” means: generate a functional case file in the `功能测试` folder, validate references and save it.
- “补自动化 / 转 UI 自动化 / 生成自动化脚本” means: inspect or prepare the UI project, assess selected functional cases, bind an iteration, explore pages, emit and verify the script, then write it into the project.
- “自动执行 / 运行自动化” means: run only explicit automationCaseIds or an explicit execution scope, then return the batch/report status.
- “更新业务地图” means: read the latest map first, then create or update only the systems, directories, functions and flows required by the request.
- If multiple documents could be “这个需求”, ask which source before writing.

## Orchestration patterns

- **Pre-processing**: the client normalizes requirements, plans pages or prepares structured inputs; Lantern validates, executes and persists the approved result.
- **Lantern-first**: Lantern collects pages, runs its configured model or executes automation; the client reviews, enriches or reconciles the output afterwards; Lantern performs the final save.
- **Interleaved**: alternate client reasoning and Lantern tools, for example plan → collect → review → save → verify.
- **Fallback**: Lantern-owned AI runs first; if it fails but preserves usable evidence, the client reads the fallback context and continues through the same Lantern save/validation boundary.
- **Multi-agent**: a coordinator or subagents may divide discovery and review work, but only current revisions and real Lantern tool outputs count as persisted state.

Do not assume a specific client name. Any MCP-capable model or orchestrator may use the same tools. Never bypass Lantern by editing JSON directly or treating an intermediate draft as saved.

## Requirement breakdown

1. On first use, call `lantern_requirement_prepare` to enable the Lantern workflow capabilities and seed their skills. Repeat calls are safe.
2. If the user supplied a file reachable by the MCP client host, call `lantern_requirement_import` with its absolute path. Set `folder` only when the user specifies a destination folder in Lantern. Keep the returned `sourcePath`.
3. When resuming an existing analysis without a known path, call `lantern_requirement_analysis_list` and select by title, source or ID. Otherwise call `lantern_requirement_context` with `sourcePath`, or call `lantern_requirement_sources` first when the desired document is already in Lantern.
4. Follow the returned Lantern analysis and outline skill instructions. Produce the `outline` and `stories` objects from its `outputContract`.
5. Preserve every exact source reference in `sourceRefs`. Do not invent a source ID.
6. For a new analysis, call `lantern_requirement_analysis_save` once with the complete result. For an existing analysis, pass its latest `existingAnalysisRevision` as `expectedRevision`.
7. Return the `analysisId`, story count, coverage-relevant source count, unresolved questions and `artifactUrl`.

## Story review

1. Call `lantern_requirement_review_context` with the `analysisId`.
2. Follow the returned Lantern review skill and `outputContract`.
3. Report only actionable conflicts, ambiguity, missing scenarios and untestable acceptance criteria.
4. Call `lantern_requirement_review_save` with the result and the current `revision`. Do not rewrite stories in the same tool call.

## Test points

1. Call `lantern_testpoints_context` with the `analysisId`.
2. Follow the returned Lantern test-point skill and `outputContract`.
3. Use only `functional`, `boundary`, `exception`, `business`, `nonfunctional`, and P0–P3 priorities.
4. Call `lantern_testpoints_save` with the complete report and the current `revision`.

## Functional case generation

1. Prefer the saved `analysisId`. Otherwise call `lantern_case_generation_context` with the known `sourcePath`.
2. Follow the returned skill and output contract. Generate rows that use only real RO / US / TP references.
3. Call `lantern_case_generation_validate`. Fix and revalidate until there are no deterministic issues.
4. Call `lantern_case_generation_save` with the context revision, source hash, rows, title and format.
5. Set `folder` to the matching case type folder, normally `功能测试`. Do not leave a functional case at the case-library root unless the user explicitly asks for root storage.
6. Report the actual saved path, case count, executable status and coverage. Do not claim coverage from the model response.

## UI automation closure

1. Call `lantern_uiauto_projects` and select a UI project by the user's project name. A UI case conversion requires a project whose detected kind is UI and, for generated scripts, Playwright.
2. If a suitable project directory already exists, call `lantern_uiauto_project_mount`. Configure the tested base URL, storageState path and environment with `lantern_uiauto_project_update` when needed.
3. If it does not exist and the user asked to create it, call `lantern_uiauto_project_scaffold_preview` first. If the preview is valid, call `lantern_uiauto_project_scaffold_create` with the explicit parent directory, then `lantern_uiauto_project_setup_start`.
4. Poll `lantern_uiauto_project_setup_get` until installation finishes. Do not invent a different environment check when setup is blocked.
5. Call `lantern_case_automation_cases` to get stable source case IDs and `lantern_case_automation_iterations` to select or create the iteration name.
6. Call `lantern_case_automation_assess` with only the user-requested caseIds, the project and iteration. Review decisions, risks and UI Plans with the user.
7. When the user asked for the complete conversion, call `lantern_case_automation_apply`. Keep returned automationCaseIds and uiSessionIds.
8. For each returned session, use `lantern_uiauto_agent_session_get`. Open the target page, inspect snapshots, wait for asynchronous conditions, perform authorized actions and bind locators with probe.
9. Save the Plan/IR with `lantern_uiauto_agent_save`, preview files with `lantern_uiauto_agent_emit`, run the isolated draft with `lantern_uiauto_agent_verify`, then merge with `lantern_uiauto_agent_write` only after the preview and verification are understood.
10. Close exploration with `lantern_uiauto_agent_close`.
11. Start formal runs with `lantern_case_automation_run`, then use `run_wait` / `run_get`. Use `run_stop` only when requested or when the run is no longer useful.
12. Report per-automationCaseId status and report paths. A formal pass may update the source case only when all linked automation cases pass and no manual result takes precedence.

## Business-map updates

1. Call `lantern_business_map_list` for the latest revision and `lantern_business_map_get` for the target system.
2. If the target system does not exist and the user authorized creation, call `lantern_business_system_save` without a systemId.
3. Create missing directories, functions and flows with the corresponding save tools and the current `expectedRevision`.
4. Base functions and flows on the requirement, attached documents, page evidence or user statements. Use draft or lower-confidence content when evidence is incomplete; never present inferred behavior as verified without evidence.
5. Re-read the map after a revision conflict and reapply only the intended change.

### Client fallback for Lantern AI failures

1. After `lantern_business_assistant_send`, use `lantern_business_assistant_wait` or `get`.
2. If the session ends with `error` or `interrupted`, inspect `session.fallback`.
3. When `fallback.available=true` and `recommendedAction="client_fallback"` (or the legacy alias `codex_fallback`), call `lantern_business_assistant_context`, then let the calling model or orchestrator reason over the returned menu, page catalog, evidence and current map. Generate only evidence-backed assets.
4. Persist the result through `lantern_business_directory_save`, `lantern_business_function_save` and `lantern_business_flow_save` using the latest revision. Do not call `lantern_business_assistant_apply`: a failed model run has no proposal to apply.
5. When `recommendedAction="retry_login"`, refresh the login state before collecting again. When it is `fix_capture`, check the entry URL, permissions and capture scope. Never invent map content from zero evidence.
6. Keep revision checks and lower-confidence/draft markers. Report that client-side fallback was used and list the evidence gaps.

## Editing existing results

- To change one story, read the analysis, then call `lantern_requirement_story_patch` with its `storyId`, `revision` and only the changed fields.
- To remove one story, call `lantern_requirement_story_delete` with its `storyId` and current `revision`. This also removes test points that referenced the story.
- If any write returns a revision conflict, call `lantern_requirement_analysis_get` again, inspect the newer Lantern content and reapply the intended change. Never retry the old payload blindly.
- After a story change leaves existing test points, state that they need review or regeneration when the change affects behavior, acceptance criteria, boundaries or source coverage.

## Data and safety

- Never edit Lantern JSON files directly.
- Never use browser automation to click Lantern UI for ordinary operations.
- Browser automation through `lantern_uiauto_agent_*` is for the target system under test, not for clicking Lantern itself.
- Use `analysisId`, `revision` and the latest saved content before modifying.
- Disabled Lantern skills are not valid workflow rules. Use `lantern_skill_list` to check status; include disabled skills only when the user asks to inspect the store.
- Previewing means not calling the save tool. Saving is a separate explicit action.
- Bulk deletion and replacing stories require an explicit user request. Delete whole analyses only with `lantern_requirement_analysis_delete`.
- Return Lantern artifact URLs and summaries to the user.
- Report only actual tool outputs. Do not say a project, script, test, regression or business flow was created unless the corresponding write/run tool returned success.
