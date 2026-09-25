import { setRuntimeVacancyActive } from "./hhru/vacancy-activity";
import { processVacancyResponses } from "./hhru/process-responses";
import { processVacancyQuestionnaire, processAnketaHrDecisions } from "./hhru/questionnaire";
import { processCandidateAnswers } from "./hhru/candidate-answers";
import { processManualDecisions } from "./hhru/manual-check";

async function main(): Promise<void> {
    const vacancy = {
        vacancyId: "pause-self-test",
        vacancyName: "PAUSE SELF TEST",
        templatesUrl: "",
    };
    setRuntimeVacancyActive(vacancy.vacancyId, false);

    const resume = await processVacancyResponses(vacancy, { dryRun: false });
    const questionnaire = await processVacancyQuestionnaire(vacancy);
    const questionnaireHr = await processAnketaHrDecisions(vacancy, { dryRun: false });
    const answers = await processCandidateAnswers(vacancy, { dryRun: false });
    const manual = await processManualDecisions(vacancy, { dryRun: false });

    const actual = {
        resume: resume.new_responses.message,
        questionnaire: questionnaire.message,
        questionnaireHr,
        answers: answers.message,
        manual: manual.message,
    };
    if (actual.resume !== "Вакансия приостановлена") throw new Error(`resume guard failed: ${actual.resume}`);
    if (actual.questionnaire !== "вакансия приостановлена") throw new Error(`questionnaire guard failed: ${actual.questionnaire}`);
    if (actual.answers !== "вакансия приостановлена") throw new Error(`answers guard failed: ${actual.answers}`);
    if (actual.manual !== "Вакансия приостановлена") throw new Error(`manual guard failed: ${actual.manual}`);
    if (questionnaireHr.invited || questionnaireHr.rejected || questionnaireHr.skipped) throw new Error("questionnaire HR guard failed");
    console.log(JSON.stringify(actual));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
