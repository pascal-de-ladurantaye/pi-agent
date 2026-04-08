import path from "node:path";

import type { DiffScope, ViewerAnnotation, ViewerAnnotationTarget } from "../types";

function annotationKey(target: ViewerAnnotationTarget): string {
	if (target.view === "code") return `code|${target.rootPath}|${target.path}|${target.startLine}-${target.endLine}`;
	return `diff|${target.repoRoot}|${target.path}|${target.scope}|${target.refs.join(",")}`;
}

export function findAnnotationByTarget(
	annotations: ViewerAnnotation[],
	target: ViewerAnnotationTarget,
): ViewerAnnotation | undefined {
	const key = annotationKey(target);
	return annotations.find((annotation) => annotationKey(annotation.target) === key);
}

export function upsertAnnotation(
	annotations: ViewerAnnotation[],
	target: ViewerAnnotationTarget,
	note: string,
): ViewerAnnotation[] {
	const key = annotationKey(target);
	const existing = annotations.find((annotation) => annotationKey(annotation.target) === key);
	if (!existing) {
		return [
			...annotations,
			{
				id: key,
				target,
				note,
				createdAt: Date.now(),
			},
		];
	}

	return annotations.map((annotation) =>
		annotation.id === existing.id
			? {
					...annotation,
					target,
					note,
				}
			: annotation,
	);
}

export function removeAnnotation(
	annotations: ViewerAnnotation[],
	target: ViewerAnnotationTarget,
): ViewerAnnotation[] {
	const key = annotationKey(target);
	return annotations.filter((annotation) => annotationKey(annotation.target) !== key);
}

export function describeAnnotationTarget(target: ViewerAnnotationTarget): string {
	if (target.view === "code") {
		const lines =
			target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}-${target.endLine}`;
		return `${target.path} (${lines})`;
	}

	const refs = target.refs.length === 1 ? target.refs[0]! : `${target.refs[0]} → ${target.refs[target.refs.length - 1]}`;
	return `${target.path} (${target.scope}, ${refs})`;
}

function formatExcerptBlock(target: ViewerAnnotationTarget): string {
	const body = target.excerpt.join("\n");
	return `\`\`\`\n${body}\n\`\`\``;
}

function formatDraftTarget(target: ViewerAnnotationTarget): string {
	if (target.view === "code") {
		const lineRef = target.startLine === target.endLine ? `${target.startLine}` : `${target.startLine}-${target.endLine}`;
		return `${target.path}:${lineRef}`;
	}

	const startRef = target.refs[0]!;
	const endRef = target.refs[target.refs.length - 1]!;
	const refRange = startRef === endRef ? startRef : `${startRef} → ${endRef}`;
	return `${target.path}:${target.scope}:${refRange}`;
}

export function buildAnnotationDraft(_cwd: string, annotations: ViewerAnnotation[]): string {
	const blocks = annotations.map((annotation) => {
		return [formatDraftTarget(annotation.target), formatExcerptBlock(annotation.target), "", annotation.note].join("\n");
	});

	return blocks.join("\n\n---\n\n");
}

export function countCodeAnnotationsForLine(
	annotations: ViewerAnnotation[],
	rootPath: string,
	filePath: string,
	lineNumber: number,
): number {
	let count = 0;
	for (const annotation of annotations) {
		if (annotation.target.view !== "code") continue;
		if (annotation.target.rootPath !== rootPath || annotation.target.path !== filePath) continue;
		if (lineNumber >= annotation.target.startLine && lineNumber <= annotation.target.endLine) count += 1;
	}
	return count;
}

export function countDiffAnnotationsForRef(
	annotations: ViewerAnnotation[],
	repoRoot: string,
	filePath: string,
	scope: DiffScope,
	ref: string | undefined,
): number {
	if (!ref) return 0;
	let count = 0;
	for (const annotation of annotations) {
		if (annotation.target.view !== "diff") continue;
		if (annotation.target.repoRoot !== repoRoot || annotation.target.path !== filePath || annotation.target.scope !== scope) continue;
		if (annotation.target.refs.includes(ref)) count += 1;
	}
	return count;
}

export function relativeRootLabel(rootPath: string): string {
	return path.basename(rootPath);
}
