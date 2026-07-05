export interface CreateUserDTO {
    tgUserId: string,
    username?: string | null
    firstName?: string | null
    lastName?: string | null
    fullNameFromGS?: string | null
    email?: string | null
}   
 

export interface VacancyGSTable {
    vacancyName: string
    vacancyUrl?: string | null
    templatesUrl?: string | null
    responsibleUsername: string
}

