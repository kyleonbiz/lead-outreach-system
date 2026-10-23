class FakeWS:
    """In-memory stand-in for a gspread worksheet."""
    def __init__(self, rows):
        self.rows = [list(r) for r in rows]

    def get_all_values(self):
        return [list(r) for r in self.rows]

    def row_values(self, n):
        return self.rows[n - 1]

    def update_cell(self, r, c, v):
        self.rows[r - 1][c - 1] = v

    def append_rows(self, rows, value_input_option=None):
        self.rows.extend([list(r) for r in rows])

    def batch_update(self, data):
        pass
