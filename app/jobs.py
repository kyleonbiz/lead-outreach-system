"""Job definitions: the existing scripts, run as subprocesses with the same schedules as the GitHub Actions workflows.

Cron expressions are UTC, copied from .github/workflows/*.yml.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Step:
    script: str
    args: tuple = ()


@dataclass(frozen=True)
class Job:
    name: str
    steps: tuple
    crons: tuple = ()               # UTC 5-field cron strings
    timeout_s: int = 900
    env: dict = field(default_factory=dict)
    needs_repo_cwd: bool = False    # send_emails.py reads logo.png from the working directory
    is_sender: bool = False         # shares the global sending lock; never auto-retried


JOBS = {j.name: j for j in [
    Job("find_leads",
        steps=(Step("find_leads.py"), Step("enrich_leads.py"), Step("write_to_sheets.py")),
        crons=("0 12-22/2 * * 1-5", "0 0 * * 2-6"),
        timeout_s=90 * 60,
        env={"MAX_RESULTS_PER_RUN": "100", "MAX_SEARCHES_PER_RUN": "60"}),
    Job("send_outreach",
        steps=(Step("send_emails.py"),),
        crons=("0 16-23 * * 1-5", "0 0-2 * * 2-6"),
        timeout_s=30 * 60,
        env={"TEST_MODE": "false"},
        needs_repo_cwd=True, is_sender=True),
    Job("daily_summary", steps=(Step("daily_summary.py"),), crons=("0 18 * * 1-5",)),
    Job("organize_leads", steps=(Step("organize_by_industry.py"),), crons=("0 0 * * *",)),
    Job("create_fb_posts", steps=(Step("create_fb_posts.py"),), crons=("0 13 * * 1",)),
]}
