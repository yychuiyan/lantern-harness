---
name: lantern-workflow
description: Use Lantern Harness MCP tools for requirement import, requirement breakdown, story review, test points and Lantern-backed test assets. Use when the user provides a requirement document or says to analyze, break down, review or generate tests with Lantern.
---

# Lantern Workflow

Lantern is the source of truth for requirement documents and test assets. Codex is the conversation and reasoning entry point.

## Routing

- “拆解这个需求” means: import or select the source, run requirement breakdown, save stories, then return a summary. Do not generate test points or test cases unless asked.
- “完整需求分析” means: breakdown, save stories, review stories, generate test points, then return the combined summary.
- “生成测试点” means: use existing saved stories and a Lantern test-point skill. Do not silently replace stories.
- “继续生成用例” or “完整测试设计” continues from the saved requirement analysis.
- If multiple documents could be “这个需求”, ask which source before writing.

## Requirement breakdown

1. On first use, call `lantern_requirement_prepare` to enable the Lantern workflow capabilities and seed their skills. Repeat calls are safe.
2. If the user supplied a local file in Codex, call `lantern_requirement_import` with its absolute path. Set `folder` only when the user specifies a destination folder in Lantern. Keep the returned `sourcePath`.
3. Call `lantern_requirement_context` with that `sourcePath`, or call `lantern_requirement_sources` first when the desired document is already in Lantern.
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

## Editing existing results

- To change one story, read the analysis, then call `lantern_requirement_story_patch` with its `storyId`, `revision` and only the changed fields.
- To remove one story, call `lantern_requirement_story_delete` with its `storyId` and current `revision`. This also removes test points that referenced the story.
- If any write returns a revision conflict, call `lantern_requirement_analysis_get` again, inspect the newer Lantern content and reapply the intended change. Never retry the old payload blindly.
- After a story change leaves existing test points, state that they need review or regeneration when the change affects behavior, acceptance criteria, boundaries or source coverage.

## Data and safety

- Never edit Lantern JSON files directly.
- Never use browser automation to click Lantern UI for ordinary operations.
- Use `analysisId`, `revision` and the latest saved content before modifying.
- Disabled Lantern skills are not valid workflow rules. Use `lantern_skill_list` to check status; include disabled skills only when the user asks to inspect the store.
- Previewing means not calling the save tool. Saving is a separate explicit action.
- Bulk deletion and replacing stories require an explicit user request.
- Return Lantern artifact URLs and summaries to the user.
