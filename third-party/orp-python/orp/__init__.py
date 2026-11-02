"""Third-party ORP v0.1 implementation — written from the memo and the vectors only.

Exercise of the implementation guide (§10): no access to the reference code
(`packages/`, `native/crates`); the interoperability vectors are the sole
arbiter.
"""


class OrpError(Exception):
    """Typed ORP error — the code carries the frozen name of the registry (§7.6 of the memo)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
