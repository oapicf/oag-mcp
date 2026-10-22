/* tslint:disable */
/* eslint-disable */
/**
 * 
 * @export
 * @interface Health
 */
export interface Health {
    /**
     * 
     */
    status: string;
}
/**
 * 
 * @export
 * @interface ModelError
 */
export interface ModelError {
    /**
     * 
     */
    code: string;
    /**
     * 
     */
    message: string;
}
/**
 * 
 * @export
 * @interface NewPet
 */
export interface NewPet {
    /**
     * 
     */
    name: string;
    /**
     * 
     */
    species: Species;
    /**
     * 
     */
    ownerId?: number;
}


/**
 * 
 * @export
 * @interface Owner
 */
export interface Owner {
    /**
     * 
     */
    id: number;
    /**
     * 
     */
    name: string;
    /**
     * 
     */
    city?: string;
}
/**
 * 
 * @export
 * @interface Pet
 */
export interface Pet {
    /**
     * 
     */
    id: number;
    /**
     * 
     */
    name: string;
    /**
     * 
     */
    species: Species;
    /**
     * 
     */
    birthDate?: string;
    /**
     * 
     */
    ownerId?: number;
    /**
     * 
     */
    vaccinated?: boolean;
    /**
     * 
     */
    weightKg?: number;
}



/**
 * 
 * @export
 */
export const Species = {
    Dog: 'dog',
    Cat: 'cat',
    Bird: 'bird',
    Rabbit: 'rabbit',
} as const;
export type Species = typeof Species[keyof typeof Species];

/**
 * 
 * @export
 * @interface Visit
 */
export interface Visit {
    /**
     * 
     */
    id: number;
    /**
     * 
     */
    date: string;
    /**
     * 
     */
    reason: string;
    /**
     * 
     */
    costCents?: number;
}
