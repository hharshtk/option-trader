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

export const quantity = new Intl.NumberFormat("en-IN");

export const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});
