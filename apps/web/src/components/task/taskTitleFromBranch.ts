/**
 * Suggests a task title from the branch it works on: the type prefix
 * (`feature/`) is dropped, separators become spaces, and a leading issue
 * number keeps its own label (`feature/#533-mx2-review` -> `#533: mx2 review`).
 */
export function taskTitleFromBranch(branch: string): string {
  const name = branch.slice(branch.lastIndexOf("/") + 1);
  const words = (value: string) => value.replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ");
  const issue = /^(#\d+)[-_]+(.+)$/.exec(name);
  if (issue !== null) {
    const rest = words(issue[2]!);
    return rest.length > 0 ? `${issue[1]}: ${rest}` : issue[1]!;
  }
  return words(name);
}
