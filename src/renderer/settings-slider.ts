interface SettingsSliderOptions {
  title: string;
  min: number;
  max: number;
  unit: string;
  optional?: boolean;
  logarithmic?: boolean;
  expandMax?: boolean;
}

const settingsSliders = new WeakMap<HTMLInputElement, () => void>();

/** Keep the original numeric input as the saved value. Slider positions are
 * presentation only: opening settings must never round a user's saved budget. */
function enhanceSettingsSlider(input: HTMLInputElement, options: SettingsSliderOptions): void {
  const existing = settingsSliders.get(input);
  if (existing) { existing(); return; }
  const control = document.createElement("div"); control.className = "settings-slider";
  const current = document.createElement("output"); current.className = "settings-slider-value";
  const slider = document.createElement("input"); slider.type = "range";
  slider.setAttribute("aria-label", `スライダー：${options.title}`);
  slider.min = String(options.optional ? 0 : options.logarithmic ? 1 : options.min);
  slider.max = String(options.logarithmic ? 1000 : options.max); slider.step = "1";
  const scale = document.createElement("div"); scale.className = "settings-slider-scale";
  const low = document.createElement("span"), high = document.createElement("span"); scale.append(low, high);
  const heading = document.createElement("div"); heading.className = "settings-slider-heading";
  // Retain the precise saved value internally; the only editable UI is the range.
  input.type = "hidden";
  input.setAttribute("aria-label", options.title);
  const clear = document.createElement("button"); clear.type = "button"; clear.className = "secondary-button compact"; clear.textContent = "未指定";
  clear.setAttribute("aria-label", `${options.title}を未指定にする`);
  input.replaceWith(control); heading.append(current); if (options.optional) heading.append(clear);
  control.append(heading, slider, scale, input);
  let maximum = options.max;
  const format = (value: number) => `${value.toLocaleString()}${options.unit === "%" ? "%" : ` ${options.unit}`}`;
  const sync = () => {
    const value = input.value === "" ? undefined : Number(input.value);
    if (options.expandMax && value !== undefined && Number.isFinite(value)) maximum = Math.max(options.max, value);
    const valid = value !== undefined && Number.isFinite(value) && value >= options.min && value <= maximum;
    const display = value === undefined ? "未指定" : valid ? format(value) : "入力範囲を確認してください";
    current.value = display; slider.setAttribute("aria-valuetext", display);
    slider.disabled = input.disabled;
    clear.disabled = input.disabled || value === undefined;
    low.textContent = options.optional ? "未指定" : format(options.min); high.textContent = format(maximum);
    slider.value = value === undefined ? slider.min : String(options.logarithmic
      ? 1 + Math.round(999 * Math.log(Math.max(options.min, value) / options.min) / Math.log(maximum / options.min))
      : value);
  };
  const commit = (value: string) => {
    input.value = value;
    // Existing draft tracking and save handlers receive the actual token count,
    // never the logarithmic slider position or a made-up subscription capacity.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  slider.addEventListener("input", () => {
    const position = Number(slider.value);
    if (options.optional && position === 0) { commit(""); return; }
    const raw = options.logarithmic ? options.min * (maximum / options.min) ** ((position - 1) / 999) : position;
    const value = position === 1000 && options.logarithmic ? maximum : Math.max(options.min, Math.min(maximum, Math.round(Number(raw.toPrecision(3)))));
    commit(String(value));
  });
  clear.onclick = () => commit("");
  input.addEventListener("input", sync);
  settingsSliders.set(input, sync); sync();
}
