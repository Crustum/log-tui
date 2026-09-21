/** Remove a child only while it is still attached — OpenTUI warns otherwise. */
export function detach(parent: any, child: any): void {
    if (!parent || !child) {
        return;
    }

    try {
        if (typeof parent.getRenderable === "function" && parent.getRenderable(child.id) !== child) {
            return;
        }

        parent.remove?.(child);
    } catch {
        // Already gone with a previous teardown.
    }
}
