from core.orchestrator.orchestrator import Orchestrator


def main():

    orchestrator = Orchestrator()

    print("Personal AI — Orchestrator v0.3")
    print("Type 'exit' to quit.\n")

    while True:

        user_message = input("You > ")

        if user_message.lower() == "exit":
            break

        try:

            plan, result = orchestrator.run(
                user_message
            )

            print("\n--- FINAL PLAN ---")
            print(
                plan.model_dump_json(indent=2)
            )

            print("\n--- FINAL RESULT ---")
            print(
                result.model_dump_json(indent=2)
            )

            print()

        except Exception as e:

            print(f"\nError: {e}\n")


if __name__ == "__main__":
    main()