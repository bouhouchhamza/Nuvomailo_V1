import {z} from "zod";

import{
    findOrganizationBySlug
} from "../repositories/organization.repository.js";

const slugSchema= z.string()
        .min(3)
        .max(63)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export async function getOrganizationBySlug(slug: string){
    const validSlug = slugSchema.parse(slug);

    return await findOrganizationBySlug(validSlug);
}
