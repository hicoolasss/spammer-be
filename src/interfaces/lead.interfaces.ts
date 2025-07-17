export interface LeadData {
  name: string;
  lastname: string;
  phone: string;
  email: string;
}

export interface FormField {
  selector: string;
  type: 'name' | 'surname' | 'phone' | 'email';
  confidence: number;
}

export interface FormAnalysis {
  formIndex: number;
  fields: FormField[];
  confidence: number;
  reason: string;
}

export interface FormAnalysisResult {
  bestForm: FormAnalysis;
  allForms: FormAnalysis[];
}
