export const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

export const signedInr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  signDisplay: "exceptZero",
});

export const signedPercent = new Intl.NumberFormat("en-IN", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const price = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const signedPrice = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const quantity = new Intl.NumberFormat("en-IN");

const istDateTimeParts = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Assembled from numeric parts rather than dateStyle/timeStyle: Node's ICU and the
// browser's word those differently ("18 Nov 2026, 6:15 am" vs "18 Nov 2026 at 6:15 AM",
// "Sep" vs "Sept"), and a server-rendered date must match the client's exactly.
export const istDateTime = {
  format(date: Date | number) {
    const part: Record<string, string> = {};
    for (const { type, value } of istDateTimeParts.formatToParts(date)) part[type] = value;
    const hour = Number(part.hour);
    return `${Number(part.day)} ${MONTHS[Number(part.month) - 1]} ${part.year}, ${hour % 12 || 12}:${part.minute} ${hour < 12 ? "AM" : "PM"}`;
  },
};

export const istTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export const compactNumber = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const signedCompactNumber = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

export const percentChange = new Intl.NumberFormat("en-IN", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
