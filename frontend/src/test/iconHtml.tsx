import { render } from "@testing-library/react";
import { Icon, type IconName } from "../components/Icon";

/** The markup inside the svg that `<Icon name>` draws, for tests that check WHICH icon a component chose (compare with an svg's `innerHTML`). */
export function iconHtml(name: IconName): string {
  const { container, unmount } = render(<Icon name={name} />);
  const html = container.querySelector("svg")!.innerHTML;
  unmount();
  return html;
}
