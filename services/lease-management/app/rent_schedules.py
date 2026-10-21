from calendar import monthrange
from datetime import date, timedelta

MAX_INSTALLMENTS = 1200
FREQUENCY_MONTHS = {"monthly": 1, "quarterly": 3, "annually": 12}


def due_date_for_month(year: int, month: int, due_day: int) -> date:
    return date(year, month, min(due_day, monthrange(year, month)[1]))


def add_months(year: int, month: int, months: int) -> tuple[int, int]:
    month_index = year * 12 + month - 1 + months
    return month_index // 12, month_index % 12 + 1


def generate_due_dates(
    start_date: date,
    end_date: date,
    due_day: int,
    payment_frequency: str,
) -> tuple[list[date], list[str]]:
    frequency_months = FREQUENCY_MONTHS[payment_frequency]
    dates: list[date] = []
    period = 0
    while period <= MAX_INSTALLMENTS:
        year, month = add_months(
            start_date.year, start_date.month, period * frequency_months
        )
        due_date = due_date_for_month(year, month, due_day)
        if due_date >= start_date:
            break
        period += 1

    while True:
        year, month = add_months(
            start_date.year, start_date.month, period * frequency_months
        )
        due_date = due_date_for_month(year, month, due_day)
        if due_date > end_date:
            break
        if len(dates) >= MAX_INSTALLMENTS:
            raise ValueError("The schedule exceeds the installment generation limit.")
        dates.append(due_date)
        period += 1

    if not dates:
        raise ValueError("The schedule range contains no payment due date.")

    next_year, next_month = add_months(
        start_date.year, start_date.month, period * frequency_months
    )
    next_due_date = due_date_for_month(next_year, next_month, due_day)
    reasons: list[str] = []
    if dates[0] != start_date:
        reasons.append("commencement_not_on_due_date")
    if end_date != next_due_date - timedelta(days=1):
        reasons.append("end_not_on_period_boundary")
    return dates, reasons
