/**
 * Removing one workspace file or folder (Files → the row's trash).
 *
 * The mirror of `upload.ts` in the direction that matters: this is HTTP because
 * it is a file operation, but unlike upload it does not go through the
 * app-server at all — there is no delete in its protocol, so `bff/src/files/delete.ts`
 * removes the path over its own bind of the workspace and answers with the
 * reason it refused, which is what this passes back as the error.
 *
 * Nothing here is a safety boundary (a browser could call the route by hand with
 * any path); the guards are the BFF's. What the UI owes the user is a confirm
 * before the call, because the answer is not undoable.
 */

export interface DeleteResult {
  /** The path that was removed, as the BFF resolved it. */
  deleted: string;
  type: "file" | "dir";
}

export async function deleteWorkspacePath(path: string): Promise<DeleteResult> {
  const response = await fetch(`/api/files/delete?path=${encodeURIComponent(path)}`, {
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    // The body is the guard's sentence ("… is not under /work", "Refusing to
    // delete …"), which is more use to a person than a status word.
    throw new Error(text || `Could not delete (${response.status})`);
  }
  try {
    return JSON.parse(text) as DeleteResult;
  } catch {
    throw new Error("Delete failed: the server answered with something unreadable");
  }
}
