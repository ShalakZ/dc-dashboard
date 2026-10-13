import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useConfirm, type ConfirmOptions } from "./useConfirm";

/** A button that asks and shows the answer. `second` asks again while the first question is still open. */
function Asker({ options = { title: 'Delete "A"?', message: "This can't be undone." }, onAnswer }: { options?: ConfirmOptions; onAnswer?: (answer: boolean) => void }) {
  const [ask, dialog] = useConfirm();
  const [answer, setAnswer] = useState("none");
  const go = async (label: string) => {
    const result = await ask(options);
    setAnswer(`${label}:${result}`);
    onAnswer?.(result);
  };
  return (
    <div>
      <button type="button" onClick={() => void go("first")}>ask</button>
      <button type="button" onClick={() => void go("second")}>ask again</button>
      <p data-testid="answer">{answer}</p>
      {dialog}
    </div>
  );
}
const answer = () => screen.getByTestId("answer").textContent;

describe("useConfirm", () => {
  it("shows nothing until asked, then one dialog with the title, the message and a Delete button in the danger tone", async () => {
    render(<Asker />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "A"?' });
    expect(dialog).toHaveTextContent("This can't be undone.");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("danger");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(answer()).toBe("none"); // still waiting
  });

  it("resolves true on the confirming button and closes the dialog", async () => {
    render(<Asker />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(answer()).toBe("first:true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("resolves false on Cancel and on Escape, each closing the dialog", async () => {
    render(<Asker />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(answer()).toBe("first:false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    await userEvent.keyboard("{Escape}");
    expect(answer()).toBe("first:false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("takes the confirm label and the tone from the options (a currency change is a primary 'Change currency')", async () => {
    render(<Asker options={{ title: "Change the currency?", message: "m", confirmLabel: "Change currency", tone: "primary" }} />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    const confirm = screen.getByRole("button", { name: "Change currency" });
    expect(confirm).toHaveClass("primary");
    expect(confirm).not.toHaveClass("danger");
  });

  it("one dialog at a time: a second question while one is open is answered false at once and does not replace the first", async () => {
    const answers: boolean[] = [];
    render(<Asker onAnswer={(a) => answers.push(a)} />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    // The backdrop covers the page for a person; the code path is still reachable, so it is tested.
    await act(async () => { screen.getByRole("button", { name: "ask again", hidden: true }).click(); });
    expect(answer()).toBe("second:false");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(answers).toEqual([false, true]);
    expect(answer()).toBe("first:true");
  });

  it("a pending question resolves false when its owner unmounts (nothing is left hanging, nothing is deleted)", async () => {
    const answers: boolean[] = [];
    const { unmount } = render(<Asker onAnswer={(a) => answers.push(a)} />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    unmount();
    await act(async () => {});
    expect(answers).toEqual([false]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("inside a form, confirming or cancelling does not submit the form", async () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    function InForm() {
      const [ask, dialog] = useConfirm();
      return (
        <form onSubmit={submit}>
          <button type="button" onClick={() => void ask({ title: "Change the currency?", message: "m", confirmLabel: "Change currency" })}>ask</button>
          {dialog}
        </form>
      );
    }
    render(<InForm />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    await userEvent.click(screen.getByRole("button", { name: "Change currency" }));
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("inside a table row the dialog is not part of the row", async () => {
    function InRow() {
      const [ask, dialog] = useConfirm();
      return (
        <table><tbody><tr><td>
          <button type="button" onClick={() => void ask({ title: "Delete this rate?", message: "m" })}>ask</button>
          {dialog}
        </td></tr></tbody></table>
      );
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<InRow />);
    await userEvent.click(screen.getByRole("button", { name: "ask" }));
    expect(screen.getByRole("dialog").closest("tr")).toBeNull();
    expect(errors).not.toHaveBeenCalled(); // no DOM-nesting complaint
    errors.mockRestore();
  });
});
