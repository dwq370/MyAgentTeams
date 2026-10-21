import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function architectureFile(root: string, projectId: string) {
  if (!PROJECT_ID.test(projectId)) throw new Error("项目无效");
  const base = path.resolve(root);
  const file = path.resolve(base, "projects", projectId, "architecture.md");
  if (!file.startsWith(`${base}${path.sep}`)) throw new Error("路径无效");
  return file;
}

export async function writeArchitectureFile(root: string, projectId: string, text: string) {
  const file = architectureFile(root, projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const body = text.trim();
  await writeFile(file, body ? `${body}\n` : "", "utf8");
}

export async function readArchitectureFile(root: string, projectId: string) {
  try {
    return (await readFile(architectureFile(root, projectId), "utf8")).trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

export async function architectureDocument(root: string, projectId: string, stored: string) {
  const file = await readArchitectureFile(root, projectId);
  return file === null ? stored.trim() : file;
}
